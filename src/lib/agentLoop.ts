import { ChatMessage, ToolCall } from '../types';
import { applyEdits, formatToolResult, READ_ONLY_TOOLS } from './tools';

/** Inspect → write re-prompts (not counting command self-correct). */
export const MAX_TOOL_CONTINUATIONS = 2;
/** Auto self-correct rounds after a failed terminal command (then stop). */
export const MAX_COMMAND_FIX_ATTEMPTS = 1;

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
}

/** Execute one tool without mutating the input; returns a new ToolCall. */
export async function executeTool(tool: ToolCall, deps: ToolExecutorDeps): Promise<ToolCall> {
  if (tool.status === 'done') return tool;

  let next: ToolCall = { ...tool, status: 'running' };

  try {
    if (tool.name === 'write_file') {
      const filePath = tool.args?.path || 'file';
      const content = tool.body || '';
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
        : `${deps.workspacePath}\\${filePath.replace(/^\//, '')}`;
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

/** Run all pending read-only tools; returns updated list + whether any ran. */
export async function runReadOnlyTools(
  tools: ToolCall[],
  deps: ToolExecutorDeps
): Promise<{ tools: ToolCall[]; hadReads: boolean }> {
  let hadReads = false;
  const out: ToolCall[] = [];
  for (const tool of tools) {
    if (READ_ONLY_TOOLS.includes(tool.name as any) && tool.status !== 'done') {
      hadReads = true;
      out.push(await executeTool(tool, deps));
    } else {
      out.push(tool);
    }
  }
  return { tools: out, hadReads };
}

/** Auto-run pending PowerShell commands (for verify / self-correct loops). */
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
    return READ_ONLY_TOOLS.includes(t.name as any) || t.name === 'run_command';
  });
}

export interface ContinueDecisionOpts {
  /** How many command-failure self-correct continuations already ran this turn. */
  commandFixAttempts?: number;
  /** Signatures of commands that already failed earlier in this turn. */
  prevFailedCmdSigs?: string[];
}

/**
 * Continue the agent loop when:
 * - code inspect tools finished and no successful write yet, or
 * - a command failed and we still have a self-correct attempt left.
 * Stops if the same command fails again or the fix budget is spent.
 */
export function shouldContinueFromTools(
  tools: ToolCall[],
  opts: ContinueDecisionOpts = {}
): boolean {
  const failedSigs = failedCommandSignatures(tools);
  if (failedSigs.length > 0) {
    const attempts = opts.commandFixAttempts ?? 0;
    if (attempts >= MAX_COMMAND_FIX_ATTEMPTS) return false;
    const prev = opts.prevFailedCmdSigs || [];
    // Same failing command again → stop (avoid retry loops)
    if (failedSigs.some(s => prev.includes(s))) return false;
    return true;
  }

  const wrote = tools.some(t => isWritableTool(t.name) && t.status === 'done');
  // read_terminal alone must not keep the loop alive
  const inspectedCode = tools.some(
    t =>
      (t.name === 'read_file' || t.name === 'list_dir' || t.name === 'search') &&
      t.status === 'done'
  );
  return inspectedCode && !wrote;
}

export function buildContinuationUserPrompt(
  feedbackTools: ToolCall[],
  opts?: { finalCommandAttempt?: boolean }
): string {
  const resultsXml = feedbackTools.map(t => formatToolResult(t)).join('\n\n');
  const cmdFailed = feedbackTools.some(t => t.name === 'run_command' && t.status === 'error');
  const hadCmd = feedbackTools.some(t => t.name === 'run_command');
  const hadTerminal = feedbackTools.some(t => t.name === 'read_terminal');

  if (cmdFailed || hadTerminal) {
    if (opts?.finalCommandAttempt) {
      return `Terminal / command results:\n${resultsXml}\n\nPrevious fix attempt did not clear the error. Briefly explain what is still wrong and stop. Do NOT re-run the same failing command. Only emit a tool if you have a clearly different fix; otherwise reply with a short diagnosis only.`;
    }
    return `Terminal / command results:\n${resultsXml}\n\nA command failed. Make ONE concrete fix with <edit_file> or <write_file>, then optionally re-run once with <run_command> to verify. If you cannot fix it confidently, explain the error and stop — do not retry the same command repeatedly.`;
  }

  if (hadCmd) {
    return `Command / terminal results:\n${resultsXml}\n\nBased on this output, take the next required step if any; otherwise briefly confirm success and stop.`;
  }

  return `Inspected workspace tool results:\n${resultsXml}\n\nBased on these file contents, please now implement the complete code. Use <write_file path="..."> or <edit_file path="..."> to write the files directly to the workspace.`;
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
