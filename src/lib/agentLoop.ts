import { ChatMessage, ToolCall } from '../types';
import { applyEdits, formatToolResult, READ_ONLY_TOOLS } from './tools';
import { pickImageTarget, placeholderSvg } from './imageRouting';

/** Fallback when settings.maxAgentSteps is missing. */
export const MAX_TOOL_CONTINUATIONS = 12;
/** Auto self-correct rounds after a failed terminal command (then stop). */
export const MAX_COMMAND_FIX_ATTEMPTS = 2;
/** Failed edit/write re-prompts before the turn stops. */
export const MAX_WRITE_FIX_ATTEMPTS = 2;
/**
 * Max times we re-prompt after read/list/search with no write.
 * Prevents endless read_file loops (Reviewer/Coder "analyzing" forever).
 */
export const MAX_READ_ONLY_CONTINUES = 2;

/** Bound the inner tool loop to settings.maxAgentSteps (default 12). */
export function toolContinuationLimit(maxAgentSteps?: number): number {
  const n = typeof maxAgentSteps === 'number' && maxAgentSteps > 0 ? Math.floor(maxAgentSteps) : MAX_TOOL_CONTINUATIONS;
  return Math.max(4, Math.min(n, 24));
}

const DESTRUCTIVE_CMD =
  /\brm\s+-rf\b|\bformat\s+[a-z]:|\bdiskpart\b|\bdel\s+\/s\b|\bremove-item\b[^\n]*-recurse[^\n]*-force|\bmkfs\b|\bshutdown\s+\/s\b/i;

export function isDestructiveCommand(cmd: string): boolean {
  return DESTRUCTIVE_CMD.test(cmd);
}

export function commandSignature(tool: ToolCall): string {
  return (tool.body || tool.args?.command || '').replace(/\s+/g, ' ').trim().toLowerCase();
}

export function failedCommandSignatures(tools: ToolCall[]): string[] {
  return tools
    .filter(t => t.name === 'run_command' && t.status === 'error')
    .map(commandSignature)
    .filter(Boolean);
}

export interface ToolExecutorDeps {
  workspacePath: string;
  onApplyFileWrite: (filePath: string, content: string) => Promise<boolean>;
  onExecuteToolCommand: (command: string) => Promise<string>;
  nodes?: import('../types').EndpointNode[];
  searxngUrl?: string;
}

/** Execute one tool without mutating the input; returns a new ToolCall. */
export async function executeTool(tool: ToolCall, deps: ToolExecutorDeps): Promise<ToolCall> {
  if (tool.status === 'done') return tool;

  let next: ToolCall = { ...tool, status: 'running' };

  try {
    if (tool.name === 'write_file') {
      const filePath = tool.args?.path || 'file';
      let content = tool.body || '';
      // Ensure JSON files never have accidental markdown code fence wrappers
      if (filePath.toLowerCase().endsWith('.json') && content.trim().startsWith('```')) {
        content = content.replace(/^\s*```[a-zA-Z0-9_\-\+#]*[ \t]*\r?\n?/, '').replace(/\r?\n?```\s*$/, '');
      }
      const ok = await deps.onApplyFileWrite(filePath, content);
      return {
        ...next,
        status: ok ? 'done' : 'error',
        result: ok ? `Wrote file ${filePath}` : `Failed to write file ${filePath}`
      };
    }

    if (tool.name === 'edit_file') {
      const filePath = tool.args?.path || 'file';
      const body = tool.body || '';
      if (!window.electronAPI) {
        return { ...next, status: 'error', result: 'Electron API unavailable' };
      }
      const absPath = filePath.includes(':')
        ? filePath
        : `${deps.workspacePath}\\${filePath.replace(/^[\\/]+/, '')}`;
      const readRes = await window.electronAPI.readFile(absPath);
      if (readRes.content === undefined) {
        return { ...next, status: 'error', result: readRes.error || `Could not read ${filePath}` };
      }
      const editRes = applyEdits(readRes.content, body);
      if (editRes.content === undefined) {
        return { ...next, status: 'error', result: `Diff failed: ${editRes.error}` };
      }
      const ok = await deps.onApplyFileWrite(filePath, editRes.content);
      return {
        ...next,
        status: ok ? 'done' : 'error',
        result: ok ? `Applied diff to ${filePath}` : `Failed to write patched ${filePath}`
      };
    }

    if (tool.name === 'run_command') {
      const cmd = tool.body || tool.args?.command || '';
      if (isDestructiveCommand(cmd)) {
        return {
          ...next,
          status: 'error',
          result: `Blocked destructive command. Run it yourself if you really want it: ${cmd}`
        };
      }
      const output = await deps.onExecuteToolCommand(cmd);
      const failed = /Exit code:\s*(?!0\b)\d+/i.test(output) || /timed out/i.test(output);
      return {
        ...next,
        status: failed ? 'error' : 'done',
        result: output || `Ran: ${cmd}`
      };
    }

    if (
      tool.name === 'read_file' ||
      tool.name === 'list_dir' ||
      tool.name === 'search' ||
      tool.name === 'read_terminal'
    ) {
      if (!window.electronAPI) {
        return { ...next, status: 'error', result: 'Electron API unavailable' };
      }
      const res = await window.electronAPI.execTool(deps.workspacePath, tool.name, tool.args);
      if (res.error) {
        return { ...next, status: 'error', result: res.error };
      }
      return { ...next, status: 'done', result: res.content || '(empty)' };
    }

    if (tool.name === 'web_search') {
      const query = tool.args?.query || tool.body || '';
      if (!window.electronAPI?.webSearch) {
        return { ...next, status: 'error', result: 'Web search API unavailable' };
      }
      const res = await window.electronAPI.webSearch(deps.searxngUrl || '', query);
      if (res.error) return { ...next, status: 'error', result: res.error };
      return { ...next, status: 'done', result: res.content || '(no results)' };
    }

    if (tool.name === 'generate_image') {
      const prompt = tool.args?.prompt || tool.body || 'placeholder';
      let rel = tool.args?.path || 'assets/generated.svg';
      const target = pickImageTarget(deps.nodes || []);
      if (!target || !window.electronAPI?.generateImage) {
        if (!rel.toLowerCase().endsWith('.svg')) rel = rel.replace(/\.[a-z0-9]+$/i, '') + '.svg';
        const ok = await deps.onApplyFileWrite(rel, placeholderSvg(prompt));
        return {
          ...next,
          status: ok ? 'done' : 'error',
          result: ok
            ? `No image-generation model is online. Wrote SVG placeholder to ${rel}`
            : `Failed to write placeholder ${rel}`
        };
      }
      const gen = await window.electronAPI.generateImage(target.node.url, target.model, prompt);
      if (!gen.ok || !gen.imageBase64) {
        if (!rel.toLowerCase().endsWith('.svg')) rel = rel.replace(/\.[a-z0-9]+$/i, '') + '.svg';
        const ok = await deps.onApplyFileWrite(rel, placeholderSvg(prompt));
        return {
          ...next,
          status: ok ? 'done' : 'error',
          result: ok
            ? `Image model ${target.model} on ${target.node.name} did not return a picture (${gen.error || 'empty'}). Wrote SVG placeholder to ${rel}`
            : `Image generation failed: ${gen.error || 'empty'}`
        };
      }
      if (!/\.(png|jpe?g|webp)$/i.test(rel)) rel = rel.replace(/\.[a-z0-9]+$/i, '') + '.png';
      const written = await window.electronAPI.execTool(deps.workspacePath, 'write_base64', {
        path: rel,
        content: gen.imageBase64
      });
      if (written.error) {
        return { ...next, status: 'error', result: written.error };
      }
      return {
        ...next,
        status: 'done',
        result: `Wrote ${rel} using ${target.model} on ${target.node.name}`
      };
    }

    return { ...next, status: 'error', result: `Unknown tool: ${tool.name}` };
  } catch (err: any) {
    return { ...next, status: 'error', result: err?.message || String(err) };
  }
}

export function isWritableTool(name: string): boolean {
  return name === 'write_file' || name === 'edit_file';
}

/** Auto-apply write_file and edit_file tools; returns updated tool list. */
export async function autoApplyWritableTools(
  tools: ToolCall[],
  deps: ToolExecutorDeps
): Promise<ToolCall[]> {
  const out: ToolCall[] = [];
  for (const tool of tools) {
    if (isWritableTool(tool.name) && tool.status !== 'done' && (tool.args?.path || tool.body)) {
      out.push(await executeTool(tool, deps));
    } else {
      out.push(tool);
    }
  }
  return out;
}

/** Stable key for identical inspect tools in one batch (path/query/terminal). */
export function readToolDedupeKey(tool: ToolCall): string | null {
  if (!READ_ONLY_TOOLS.includes(tool.name as any)) return null;
  if (tool.name === 'read_terminal') return 'read_terminal';
  if (tool.name === 'read_file' || tool.name === 'list_dir') {
    const path = (tool.args?.path || tool.body || '').replace(/\\/g, '/').trim().toLowerCase();
    return path ? `${tool.name}:${path}` : `${tool.name}:`;
  }
  if (tool.name === 'search') {
    const q = (tool.args?.query || tool.body || '').replace(/\s+/g, ' ').trim().toLowerCase();
    return q ? `search:${q}` : 'search:';
  }
  return `${tool.name}`;
}

/**
 * Collapse duplicate inspect tools (same path/query) so a model that spam-emits
 * the same <read_file> hundreds of times only executes once.
 */
export function collapseDuplicateReadTools(tools: ToolCall[]): ToolCall[] {
  const seen = new Set<string>();
  const out: ToolCall[] = [];
  for (const tool of tools) {
    const key = readToolDedupeKey(tool);
    if (!key) {
      out.push(tool);
      continue;
    }
    if (seen.has(key)) {
      if (tool.status === 'done' || tool.status === 'error') {
        out.push(tool);
        continue;
      }
      out.push({
        ...tool,
        status: 'done',
        result: `(skipped duplicate ${tool.name} — already captured this turn)`
      });
      continue;
    }
    seen.add(key);
    out.push(tool);
  }
  return out;
}

/**
 * True when the model is stuck repeating the same tool tag or line
 * (classic local-LLM collapse). Threshold is consecutive identical hits.
 */
export function detectRepeatedToolTagSpam(text: string, threshold = 8): boolean {
  if (!text || threshold < 3) return false;
  const re =
    /<(read_file|list_dir|search|read_terminal|write_file|edit_file|run_command)\b[^>]*\/?>/gi;
  let prev = '';
  let streak = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const tag = m[0].replace(/\s+/g, ' ').trim().toLowerCase();
    if (tag && tag === prev) {
      streak += 1;
      if (streak >= threshold) return true;
    } else {
      prev = tag;
      streak = 1;
    }
  }
  // Also catch non-tool line loops (same line emitted over and over).
  const lines = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  if (lines.length >= threshold) {
    let lineStreak = 1;
    for (let i = 1; i < lines.length; i++) {
      if (lines[i] === lines[i - 1] && lines[i].length >= 12) {
        lineStreak += 1;
        if (lineStreak >= threshold) return true;
      } else {
        lineStreak = 1;
      }
    }
  }
  return false;
}

/** Run all pending read-only tools; returns updated list + whether any ran. */
export async function runReadOnlyTools(
  tools: ToolCall[],
  deps: ToolExecutorDeps
): Promise<{ tools: ToolCall[]; hadReads: boolean }> {
  let hadReads = false;
  const seenKeys = new Set<string>();
  const out: ToolCall[] = [];
  for (const tool of collapseDuplicateReadTools(tools)) {
    if (READ_ONLY_TOOLS.includes(tool.name as any) && tool.status !== 'done' && tool.status !== 'error') {
      const key = readToolDedupeKey(tool);
      if (key && seenKeys.has(key)) {
        out.push({
          ...tool,
          status: 'done',
          result: `(skipped duplicate ${tool.name} — already captured this turn)`
        });
        hadReads = true;
        continue;
      }
      if (key) seenKeys.add(key);
      hadReads = true;
      out.push(await executeTool(tool, deps));
    } else {
      const key = readToolDedupeKey(tool);
      if (key && (tool.status === 'done' || tool.status === 'error')) seenKeys.add(key);
      out.push(tool);
    }
  }
  return { tools: out, hadReads };
}

export async function runAuxTools(tools: ToolCall[], deps: ToolExecutorDeps): Promise<ToolCall[]> {
  const out: ToolCall[] = [];
  for (const tool of tools) {
    if (
      (tool.name === 'web_search' || tool.name === 'generate_image') &&
      tool.status !== 'done' &&
      tool.status !== 'error'
    ) {
      out.push(await executeTool(tool, deps));
    } else {
      out.push(tool);
    }
  }
  return out;
}
export async function runCommandTools(
  tools: ToolCall[],
  deps: ToolExecutorDeps
): Promise<{ tools: ToolCall[]; hadCommands: boolean }> {
  let hadCommands = false;
  const out: ToolCall[] = [];
  for (const tool of tools) {
    if (
      tool.name === 'run_command' &&
      tool.status !== 'done' &&
      tool.status !== 'error' &&
      (tool.body || tool.args?.command)
    ) {
      hadCommands = true;
      out.push(await executeTool(tool, deps));
    } else {
      out.push(tool);
    }
  }
  return { tools: out, hadCommands };
}

export function replaceToolsInMessage(
  messages: ChatMessage[],
  messageId: string,
  tools: ToolCall[]
): ChatMessage[] {
  return messages.map(m => (m.id === messageId ? { ...m, toolCalls: tools } : m));
}

/** Tools whose results should be fed back into the next model turn. */
export function collectFeedbackTools(tools: ToolCall[]): ToolCall[] {
  return tools.filter(t => {
    if (t.status !== 'done' && t.status !== 'error') return false;
    if (READ_ONLY_TOOLS.includes(t.name as any) || t.name === 'run_command') return true;
    if (t.name === 'web_search' || t.name === 'generate_image') return true;
    if ((t.name === 'write_file' || t.name === 'edit_file') && t.status === 'error') return true;
    return false;
  });
}

export interface ContinueDecisionOpts {
  /** How many command-failure self-correct continuations already ran this turn. */
  commandFixAttempts?: number;
  /** Signatures of commands that already failed earlier in this turn. */
  prevFailedCmdSigs?: string[];
  /** Failed write/edit re-prompts already used. */
  writeFixAttempts?: number;
  /** How many read-only (inspect, no write) continues already used this turn. */
  readOnlyContinues?: number;
  /** Cap for read-only continues (default MAX_READ_ONLY_CONTINUES). Reviewer uses 1. */
  maxReadOnlyContinues?: number;
  /** Normalized fingerprint of the last read_terminal result this turn. */
  terminalFingerprint?: string;
}

/** True when read_terminal returned an empty Studio terminal buffer. */
export function isEmptyTerminalResult(result?: string): boolean {
  const text = (result || '').trim();
  if (!text) return true;
  if (/\(terminal is empty\)/i.test(text)) return true;
  if (/skipped duplicate read_terminal/i.test(text)) return true;
  if (/Terminal\s*\(\s*0\s*chars/i.test(text)) return true;
  // "Terminal (N chars...):\n" with nothing meaningful after the header
  const afterHeader = text.replace(/^Terminal\s*\([^)]*\)\s*:?\s*/i, '').trim();
  if (/^Terminal\b/i.test(text) && (!afterHeader || /^\(terminal is empty\)$/i.test(afterHeader))) {
    return true;
  }
  return false;
}

/** Stable fingerprint for comparing terminal snapshots across continues. */
export function terminalResultFingerprint(result?: string): string {
  return (result || '')
    .replace(/\r\n/g, '\n')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()
    .slice(0, 2000);
}

/** First real (non-duplicate) done read_terminal result in a batch. */
export function latestTerminalResult(tools: ToolCall[]): string | undefined {
  for (let i = tools.length - 1; i >= 0; i--) {
    const t = tools[i];
    if (t.name !== 'read_terminal' || t.status !== 'done') continue;
    if (/skipped duplicate read_terminal/i.test(t.result || '')) continue;
    return t.result;
  }
  return undefined;
}

/**
 * Continue the agent loop when:
 * - code inspect tools finished and no successful write yet (bounded), or
 * - a command failed and we still have a self-correct attempt left.
 * Stops if the same command fails again, the fix budget is spent, or too many
 * read-only continues (endless read_file loops).
 */
export function shouldContinueFromTools(
  tools: ToolCall[],
  opts: ContinueDecisionOpts = {}
): boolean {
  const doneTools = tools.filter(t => t.status === 'done' || t.status === 'error');
  const terminalOnly =
    doneTools.length > 0 && doneTools.every(t => t.name === 'read_terminal');
  if (terminalOnly) return false;

  const cmdFailed = tools.some(t => t.name === 'run_command' && t.status === 'error');
  const writeFailed = tools.some(
    t => (t.name === 'write_file' || t.name === 'edit_file') && t.status === 'error'
  );
  const hadTerminalDone = tools.some(
    t =>
      t.name === 'read_terminal' &&
      t.status === 'done' &&
      !/skipped duplicate read_terminal/i.test(t.result || '')
  );
  // Successful terminal snapshot already in hand — another auto-turn just re-reads it.
  if (hadTerminalDone && !cmdFailed && !writeFailed) return false;

  const termResult = latestTerminalResult(tools);
  if (termResult && opts.terminalFingerprint) {
    const fp = terminalResultFingerprint(termResult);
    if (fp && fp === opts.terminalFingerprint) return false;
  }

  const failedSigs = failedCommandSignatures(tools);
  if (failedSigs.length > 0) {
    const attempts = opts.commandFixAttempts ?? 0;
    if (attempts >= MAX_COMMAND_FIX_ATTEMPTS) return false;
    const prev = opts.prevFailedCmdSigs || [];
    // Same failing command again → stop (avoid retry loops)
    if (failedSigs.some(s => prev.includes(s))) return false;
    return true;
  }

  if (writeFailed && (opts.writeFixAttempts ?? 0) < MAX_WRITE_FIX_ATTEMPTS) return true;

  const wrote = tools.some(t => isWritableTool(t.name) && t.status === 'done');
  // read_terminal alone must not keep the loop alive
  const inspectedCode = tools.some(
    t =>
      (t.name === 'read_file' || t.name === 'list_dir' || t.name === 'search') &&
      t.status === 'done'
  );
  if (!(inspectedCode && !wrote)) return false;
  const maxReads = opts.maxReadOnlyContinues ?? MAX_READ_ONLY_CONTINUES;
  const used = opts.readOnlyContinues ?? 0;
  return used < maxReads;
}

/** True when this tool batch was exploration-only (no successful write/edit). */
export function isReadOnlyToolBatch(tools: ToolCall[]): boolean {
  const wrote = tools.some(t => isWritableTool(t.name) && t.status === 'done');
  if (wrote) return false;
  return tools.some(
    t =>
      (t.name === 'read_file' || t.name === 'list_dir' || t.name === 'search') &&
      t.status === 'done'
  );
}

export function buildContinuationUserPrompt(
  feedbackTools: ToolCall[],
  opts?: { finalCommandAttempt?: boolean }
): string {
  const resultsXml = feedbackTools.map(t => formatToolResult(t)).join('\n\n');
  const cmdFailed = feedbackTools.some(t => t.name === 'run_command' && t.status === 'error');
  const writeFailed = feedbackTools.some(
    t => (t.name === 'write_file' || t.name === 'edit_file') && t.status === 'error'
  );
  const hadCmd = feedbackTools.some(t => t.name === 'run_command');
  const terminalReads = feedbackTools.filter(t => t.name === 'read_terminal');
  const hadTerminal = terminalReads.length > 0;
  const emptyTerminal = terminalReads.some(
    t => t.status === 'done' && isEmptyTerminalResult(t.result)
  );

  if (cmdFailed) {
    if (opts?.finalCommandAttempt) {
      return `Terminal / command results:\n${resultsXml}\n\nPrevious fix attempt did not clear the error. Briefly explain what is still wrong and stop. Do NOT re-run the same failing command. Only emit a tool if you have a clearly different fix; otherwise reply with a short diagnosis only.`;
    }
    return `Terminal / command results:\n${resultsXml}\n\nA command failed. Make ONE concrete fix with <edit_file> or <write_file>, then optionally re-run once with <run_command> to verify. If you cannot fix it confidently, explain the error and stop — do not retry the same command repeatedly.`;
  }

  if (hadTerminal && !hadCmd) {
    if (emptyTerminal) {
      return `Terminal / command results:\n${resultsXml}\n\nThe Studio terminal buffer is empty. Do NOT call <read_terminal> again. If you need command output, run something with <run_command>; otherwise proceed without terminal context or stop.`;
    }
    return `Terminal / command results:\n${resultsXml}\n\nYou already have the terminal output. Do NOT call <read_terminal> again. Act on it (fix/write) or stop.`;
  }

  if (writeFailed) {
    const editFailed = feedbackTools.some(t => t.name === 'edit_file' && t.status === 'error');
    if (editFailed) {
      return `File edit failed:\n${resultsXml}\n\nThe SEARCH block could not be matched. Output the entire corrected file with <write_file path="..."> (full contents). Do not retry the same SEARCH/REPLACE. Do not repeat a destructive command.`;
    }
    return `File write failed:\n${resultsXml}\n\nFix the file with a corrected <write_file> for the same path. Do not repeat a destructive command.`;
  }

  if (hadCmd) {
    const termNote = emptyTerminal
      ? '\n\nNote: a later <read_terminal> was empty — do not call <read_terminal> again.'
      : '';
    return `Command / terminal results:\n${resultsXml}\n\nBased on this output, take the next required step if any; otherwise briefly confirm success and stop.${termNote}`;
  }

  return `Inspected workspace tool results:\n${resultsXml}\n\nYou already have the file contents above. Do NOT read the same files again. Take the next required action now (write/edit for Coder; <review_plan> for Reviewer; <plan_options> for Planner).`;
}

export type ApiChatMessage = {
  role: string;
  content: string;
  images?: string[];
};

export function historyForModel(
  messages: ChatMessage[],
  stripThinking: (raw: string) => string
): ApiChatMessage[] {
  return messages
    .filter(m => m.role === 'user' || m.role === 'assistant')
    .map(m => {
      const content = stripThinking(m.raw || m.display || '');
      const entry: ApiChatMessage = { role: m.role, content };
      if (m.role === 'user' && m.images && m.images.length > 0) {
        // Ollama expects raw base64 (no data: prefix)
        entry.images = m.images.map(img => {
          const i = img.indexOf('base64,');
          return i >= 0 ? img.slice(i + 7) : img;
        });
      }
      return entry;
    })
    .filter(m => m.content.trim().length > 0 || (m.images && m.images.length > 0));
}

