import { AgentPersona, EndpointNode, ToolCall, ToolName } from '../types';

export const READ_ONLY_TOOLS: ToolName[] = ['read_file', 'list_dir', 'search', 'read_terminal'];
const ALL_TOOLS: ToolName[] = [
  'read_file',
  'list_dir',
  'search',
  'write_file',
  'edit_file',
  'run_command',
  'read_terminal'
];
const TOOL_ALT = ALL_TOOLS.join('|');

// ==========================================
// Parsing
// ==========================================

function parseAttrs(s: string): Record<string, string> {
  const out: Record<string, string> = {};
  const re = /(\w+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
  let m;
  while ((m = re.exec(s)) !== null) out[m[1]] = m[2] ?? m[3] ?? '';
  return out;
}

/** Remove a single wrapping ``` fence if the model fenced the whole body. */
function unfence(body: string): string {
  let b = body.replace(/^\r?\n/, '').replace(/\r?\n[ \t]*$/, '');
  const fenced = b.match(/^\s*```[^\n]*\n([\s\S]*?)\n?```\s*$/);
  if (fenced) b = fenced[1];
  return b;
}

export interface ParsedResponse {
  display: string;
  thinking: string;
  toolCalls: ToolCall[];
  /** true while a tool tag has been opened but not yet closed (streaming) */
  pendingTool?: { name: string; path?: string };
}

/** True when the user asked to create/build/write files (enables markdown fallback writes). */
export function looksLikeCreateIntent(text: string): boolean {
  return /\b(create|build|make|write|generate|implement|scaffold|add|fix|new)\b/i.test(text)
    && /\b(file|app|application|webpage|web\s*page|website|script|component|project|gui|window|program|module|page|html|css|js|python|code)\b/i.test(text);
}

export interface ParseResponseOptions {
  /** Conductor-assigned path — always allow fallback write for this file */
  expectedFilePath?: string;
  /** When true, language-default filenames may be invented from fences */
  createIntent?: boolean;
}

/**
 * Parse model output into display text + tool calls.
 * IDs are deterministic (message id + index) so React state on tool cards survives re-renders while streaming.
 */
export function parseResponse(
  text: string,
  msgId: string,
  streaming = false,
  expectedFilePathOrOpts?: string | ParseResponseOptions
): ParsedResponse {
  const opts: ParseResponseOptions =
    typeof expectedFilePathOrOpts === 'string'
      ? { expectedFilePath: expectedFilePathOrOpts, createIntent: true }
      : expectedFilePathOrOpts || {};
  const expectedFilePath = opts.expectedFilePath;
  const createIntent = opts.createIntent ?? !!expectedFilePath;
  const toolCalls: ToolCall[] = [];
  let thinking = '';

  // Pull out <think> blocks some models emit inline
  let work = text.replace(/<think>([\s\S]*?)(<\/think>|$)/g, (_m, t) => {
    thinking += t;
    return '';
  });

  const blockRe = new RegExp(`<(${TOOL_ALT})\\b([^>]*?)(?<!/)>([\\s\\S]*?)</\\1\\s*>`, 'g');
  const selfRe = new RegExp(`<(${TOOL_ALT})\\b([^>]*?)/>`, 'g');

  // Replace each call with a numbered placeholder, then read placeholders back in document order
  const found: { name: ToolName; attrs: string; body?: string }[] = [];
  work = work.replace(blockRe, (_m, name, attrs, body) => {
    found.push({ name, attrs, body });
    return `\u0000${found.length - 1}\u0000`;
  });
  work = work.replace(selfRe, (_m, name, attrs) => {
    found.push({ name, attrs });
    return `\u0000${found.length - 1}\u0000`;
  });

  const order: number[] = [];
  for (const m of work.matchAll(/\u0000(\d+)\u0000/g)) order.push(Number(m[1]));

  order.forEach((fi, idx) => {
    const f = found[fi];
    const args = parseAttrs(f.attrs);
    // Normalize path attribute if model used file="", filename="", or target=""
    if (!args.path) {
      const fallbackPath = args.file || args.filename || args.target || args.name || expectedFilePath;
      if (fallbackPath) args.path = fallbackPath;
    }
    let body: string | undefined;
    if (f.name === 'write_file') body = unfence(f.body ?? '');
    else if (f.name === 'edit_file') body = f.body ?? '';
    else if (f.name === 'run_command') {
      body = unfence(f.body ?? '').trim();
      if (!body && args.command) body = args.command;
    } else if (f.name === 'read_terminal') {
      const raw = (f.body ?? '').trim();
      if (!args.lines && /^\d+$/.test(raw)) args.lines = raw;
    } else if (f.body && f.body.trim() && !args.path) {
      args.path = f.body.trim();
    }
    toolCalls.push({ id: `${msgId}-t${idx}`, name: f.name, args, body, status: 'pending' });
  });

  let display = work.replace(/\u0000\d+\u0000/g, '');

  // Hide a tool tag that is still being streamed
  let pendingTool: ParsedResponse['pendingTool'];
  if (streaming) {
    const openRe = new RegExp(`<(${TOOL_ALT})\\b([^>]*)>?[\\s\\S]*$`);
    const open = display.match(openRe);
    if (open) {
      pendingTool = { name: open[1], path: parseAttrs(open[2] || '').path };
      display = display.slice(0, open.index);
    }
  }

  // Drop empty fences left behind when a model wrapped tool tags in ``` blocks
  display = display.replace(/```[a-z]*\s*```/gi, '').replace(/\n{3,}/g, '\n\n').trim();

  // Universal Fallback: If no explicit XML tool tags were detected and generation finished,
  // inspect markdown code blocks. Guarded so Q&A / explanatory replies do not invent files.
  if (!streaming && toolCalls.length === 0 && (createIntent || expectedFilePath)) {
    const codeBlockRe = /```([a-zA-Z0-9_\-\+#]*)(?:[ \t:]+([^\r\n]+))?\r?\n([\s\S]*?)\r?\n```/g;
    let match: RegExpExecArray | null;
    let fallbackIdx = 0;
    const usedNames = new Set<string>();

    const LANG_DEFAULT_FILE: Record<string, string> = {
      html: 'index.html',
      htm: 'index.html',
      css: 'styles.css',
      scss: 'styles.scss',
      js: 'app.js',
      javascript: 'app.js',
      ts: 'main.ts',
      typescript: 'main.ts',
      tsx: 'App.tsx',
      jsx: 'App.jsx',
      py: 'main.py',
      python: 'main.py',
      cs: 'Program.cs',
      csharp: 'Program.cs',
      'c#': 'Program.cs',
      cpp: 'main.cpp',
      'c++': 'main.cpp',
      c: 'main.c',
      rs: 'main.rs',
      rust: 'main.rs',
      go: 'main.go',
      golang: 'main.go',
      ps1: 'app.ps1',
      powershell: 'app.ps1',
      bat: 'run.bat',
      batch: 'run.bat',
      cmd: 'run.cmd',
      xaml: 'MainWindow.xaml',
      xml: 'config.xml',
      json: 'package.json',
      yaml: 'config.yaml',
      yml: 'config.yml',
      sql: 'schema.sql',
      java: 'Main.java'
    };

    while ((match = codeBlockRe.exec(work)) !== null) {
      const lang = (match[1] || '').toLowerCase().trim();
      const info = (match[2] || '').trim();
      const content = match[3];
      const matchIndex = match.index;

      // Skip very tiny snippets unless expectedFilePath is set
      if (content.trim().length < 20 && !expectedFilePath) continue;

      // Check if it's a pure single-line shell install/build command
      const lines = content.trim().split(/\r?\n/);
      if (
        (lang === 'bash' || lang === 'sh' || lang === 'shell' || lang === 'cmd' || lang === 'powershell' || lang === 'ps1') &&
        lines.length <= 2 &&
        /^(npm |pip |python |dotnet |cargo |gcc |g\+\+ |pyinstaller |winget )/.test(lines[0].trim()) &&
        !expectedFilePath
      ) {
        toolCalls.push({
          id: `${msgId}-fb-cmd-${fallbackIdx++}`,
          name: 'run_command',
          args: { command: content.trim() },
          body: content.trim(),
          status: 'pending'
        });
        continue;
      }

      let detectedFilename: string | undefined = fallbackIdx === 0 && expectedFilePath ? expectedFilePath : undefined;
      let pathExplicit = !!detectedFilename;

      // 1. Check fence info (e.g. ```python:main.py or ```csharp Program.cs)
      if (!detectedFilename && info) {
        const infoMatch = info.match(/(?:filename=|file=|path=)?["'`]?([a-zA-Z0-9_\-\./\\]+\.[a-zA-Z0-9]+)["'`]?/i);
        if (infoMatch) {
          detectedFilename = infoMatch[1];
          pathExplicit = true;
        }
      }

      // 2. Check preceding text (up to 260 chars) before code block for any filename mention (`main.py`, **Program.cs**, ### index.html, etc.)
      if (!detectedFilename) {
        const precedingText = work.slice(Math.max(0, matchIndex - 260), matchIndex);
        const matches = Array.from(
          precedingText.matchAll(
            /(?:###|##|#|\*\*|`|"|'|File:?|Filename:?|Create|Save as|In)\s*[`"']*([a-zA-Z0-9_\-\./\\]+\.[a-zA-Z0-9]{1,6})[`"'*:]*/gi
          )
        );
        if (matches.length > 0) {
          detectedFilename = matches[matches.length - 1][1];
          pathExplicit = true;
        }
      }

      // 3. Check first 2 lines inside code content for comment with filename
      if (!detectedFilename) {
        const firstTwoLines = content.slice(0, 220).split('\n').slice(0, 2).join('\n');
        const commentMatch = firstTwoLines.match(/(?:<!--|\/\/|\/\*|#)\s*(?:File:?|Filename:?)?\s*([a-zA-Z0-9_\-\./\\]+\.[a-zA-Z0-9]{1,6})/i);
        if (commentMatch) {
          detectedFilename = commentMatch[1];
          pathExplicit = true;
        }
      }

      // 4. Language & Content Signatures — only when createIntent (or conductor path)
      if (!detectedFilename && createIntent) {
        if (lang && LANG_DEFAULT_FILE[lang]) {
          detectedFilename = LANG_DEFAULT_FILE[lang];
        } else if (content.includes('<!DOCTYPE html>') || content.includes('<html') || (content.includes('<head') && content.includes('<body'))) {
          detectedFilename = 'index.html';
        } else if (content.includes('import tkinter') || content.includes('from tkinter') || content.includes('PyQt') || content.includes('def main(')) {
          detectedFilename = 'main.py';
        } else if (content.includes('using System') || content.includes('namespace ') || content.includes('Application.Run(')) {
          detectedFilename = 'Program.cs';
        } else if (content.includes('#include <windows.h>') || content.includes('int WINAPI WinMain') || content.includes('#include <iostream>')) {
          detectedFilename = 'main.cpp';
        } else if (content.includes('Add-Type -AssemblyName System.Windows.Forms')) {
          detectedFilename = 'app.ps1';
        }
      }

      // Without createIntent, only keep fences that named an explicit path
      if (detectedFilename && !createIntent && !expectedFilePath && !pathExplicit) {
        detectedFilename = undefined;
      }

      if (detectedFilename) {
        let sanitized = detectedFilename.replace(/^[\/\\]+/, '').replace(/\.\.[\/\\]+/g, '');
        if (usedNames.has(sanitized)) {
          const dotIdx = sanitized.lastIndexOf('.');
          sanitized = dotIdx > 0
            ? `${sanitized.slice(0, dotIdx)}_${fallbackIdx + 1}${sanitized.slice(dotIdx)}`
            : `${sanitized}_${fallbackIdx + 1}`;
        }
        usedNames.add(sanitized);

        toolCalls.push({
          id: `${msgId}-fb-${fallbackIdx++}`,
          name: 'write_file',
          args: { path: sanitized },
          body: content,
          status: 'pending'
        });
      }
    }

    // If expectedFilePath was provided (e.g. from Conductor worker assignment) and model returned raw unfenced code
    if (toolCalls.length === 0 && expectedFilePath && work.trim().length > 20) {
      toolCalls.push({
        id: `${msgId}-fb-raw`,
        name: 'write_file',
        args: { path: expectedFilePath },
        body: unfence(work.trim()),
        status: 'pending'
      });
    }
  }

  return { display, thinking: thinking.trim(), toolCalls, pendingTool };
}

/** History sent back to the model: drop inline thinking to save context. */
export const stripThinking = (raw: string) => raw.replace(/<think>[\s\S]*?<\/think>/g, '').trim();

// ==========================================
// SEARCH/REPLACE edits
// ==========================================

export interface EditResult {
  content?: string;
  error?: string;
  applied: number;
}

export function parseEditBlocks(body: string): { search: string; replace: string }[] {
  const blocks: { search: string; replace: string }[] = [];
  const re = /^<{5,9}\s*SEARCH[^\n]*\n([\s\S]*?)^={5,9}[ \t]*\r?\n([\s\S]*?)^>{5,9}\s*REPLACE/gm;
  let m;
  while ((m = re.exec(body)) !== null) {
    blocks.push({
      search: m[1].replace(/\r?\n$/, ''),
      replace: m[2].replace(/\r?\n$/, '')
    });
  }
  return blocks;
}

function countOccurrences(hay: string, needle: string): number {
  if (!needle) return 0;
  let n = 0;
  let i = 0;
  while ((i = hay.indexOf(needle, i)) !== -1) {
    n++;
    i += needle.length;
  }
  return n;
}

/** Fallback: match ignoring leading/trailing whitespace on each line. Returns [startLine, endLine) or null. */
function fuzzyLineMatch(lines: string[], searchLines: string[]): [number, number] | null {
  const norm = (s: string) => s.trim();
  const target = searchLines.map(norm);
  // drop leading/trailing blank lines from the search
  while (target.length && !target[0]) target.shift();
  while (target.length && !target[target.length - 1]) target.pop();
  if (!target.length) return null;
  const hits: number[] = [];
  for (let i = 0; i + target.length <= lines.length; i++) {
    let ok = true;
    for (let j = 0; j < target.length; j++) {
      if (norm(lines[i + j]) !== target[j]) {
        ok = false;
        break;
      }
    }
    if (ok) hits.push(i);
  }
  return hits.length === 1 ? [hits[0], hits[0] + target.length] : null;
}

export function applyEdits(original: string, body: string): EditResult {
  const blocks = parseEditBlocks(body);
  if (!blocks.length) {
    return { applied: 0, error: 'No valid SEARCH/REPLACE blocks found. Use the exact <<<<<<< SEARCH / ======= / >>>>>>> REPLACE format.' };
  }
  const eol = original.includes('\r\n') ? '\r\n' : '\n';
  let text = original.replace(/\r\n/g, '\n');

  for (let i = 0; i < blocks.length; i++) {
    const { search, replace } = blocks[i];
    if (!search.trim()) {
      if (!text.trim()) {
        text = replace;
        continue;
      }
      return { applied: i, error: `Block ${i + 1}: empty SEARCH section. To append, search for the last lines of the file.` };
    }
    const count = countOccurrences(text, search);
    if (count === 1) {
      text = text.replace(search, () => replace);
      continue;
    }
    if (count > 1) {
      return { applied: i, error: `Block ${i + 1}: SEARCH text matches ${count} places. Include more surrounding lines so it is unique.` };
    }
    const lines = text.split('\n');
    const range = fuzzyLineMatch(lines, search.split('\n'));
    if (!range) {
      return {
        applied: i,
        error: `Block ${i + 1}: SEARCH text not found in the file. Re-read the file with read_file and copy the lines exactly.`
      };
    }
    lines.splice(range[0], range[1] - range[0], ...replace.split('\n'));
    text = lines.join('\n');
  }
  return { applied: blocks.length, content: eol === '\r\n' ? text.replace(/\n/g, '\r\n') : text };
}

// ==========================================
// Prompt construction
// ==========================================

export const TOOL_PROTOCOL = `## Autonomous Workspace Tools & Protocol
You are paired with a developer in an autonomous local IDE. You have direct filesystem access through tool tags.
Whenever asked to build, create, modify, or run code, you MUST invoke the appropriate tool tags directly. Do NOT just print conversational markdown code blocks or describe what to do—take immediate action by emitting the tool tags!

### 1. Create or Rewrite Files: <write_file>
When creating new files (like a webpage, script, component, or config), write the complete file inside <write_file path="...">:
<write_file path="index.html">
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>App</title>
</head>
<body>
  <h1>Hello World</h1>
</body>
</html>
</write_file>

You can create multiple files in one message:
<write_file path="styles.css">
body { font-family: sans-serif; background: #121212; color: #eee; }
</write_file>

### 2. Incremental Edits to Existing Files: <edit_file>
Use exact SEARCH/REPLACE blocks for existing files. Always read the file first if you are unsure of its contents:
<edit_file path="src/main.ts">
<<<<<<< SEARCH
function hello() {
  console.log("old");
}
=======
function hello() {
  console.log("new");
}
>>>>>>> REPLACE
</edit_file>

### 3. Read Files and Inspect Codebase:
<read_file path="src/app.ts"/>
<list_dir path="." depth="2"/>
<search query="searchKeyword" path="src"/>

### 4. Run PowerShell Commands:
<run_command>npm test</run_command>

### 5. Monitor the IDE Terminal (self-correct):
Read recent PowerShell output from the LocalAgents terminal panel (includes commands the user ran and prior agent runs):
<read_terminal/>
<read_terminal lines="60"/>

When a command fails (non-zero exit), diagnose from the output, fix with <edit_file> or <write_file>, then re-run with <run_command>. Prefer <read_terminal/> if the user already ran something in the terminal and you need that output.

### Mandatory Rules:
- MANDATORY: When the user asks you to build, create, or write code (e.g. "build a webpage", "create a python script"), you MUST invoke <write_file path="...">. DO NOT respond only with conversational text and raw markdown code blocks. The user expects the file to be created on their computer.
- After writing code that should be verified, run a relevant command (<run_command>) and fix failures from the terminal output before stopping.
- Paths are relative to the workspace root. Do not prefix with leading slash.
- State a brief 1-2 sentence description before or after the tool tags.`;

export function buildSystemPrompt(agent: AgentPersona, workspace: string, overview: string): string {
  const parts = [
    agent.systemPrompt.trim(),
    `## Environment
- Host OS: Windows (PowerShell)
- Workspace root: ${workspace || '(no folder open)'}
- Date: ${new Date().toISOString().slice(0, 10)}`
  ];
  if (agent.toolsEnabled) parts.push(TOOL_PROTOCOL);
  if (overview) parts.push(`## Workspace overview\n${overview}`);
  return parts.join('\n\n');
}

export function formatToolResult(call: ToolCall): string {
  const attrs = call.args.path
    ? ` path="${call.args.path}"`
    : call.name === 'run_command'
      ? ` command="${(call.body || '').replace(/"/g, "'").slice(0, 120)}"`
      : call.name === 'read_terminal' && call.args.lines
        ? ` lines="${call.args.lines}"`
        : '';
  return `<tool_result name="${call.name}"${attrs} status="${call.status}">\n${call.result ?? ''}\n</tool_result>`;
}

export function describeTool(call: ToolCall): string {
  switch (call.name) {
    case 'read_file':
      return `Read ${call.args.path}${call.args.start ? ` (${call.args.start}-${call.args.end ?? 'end'})` : ''}`;
    case 'list_dir':
      return `List ${call.args.path || '.'}`;
    case 'search':
      return `Search "${call.args.query}"${call.args.path ? ` in ${call.args.path}` : ''}`;
    case 'write_file':
      return `Write ${call.args.path}`;
    case 'edit_file':
      return `Edit ${call.args.path}`;
    case 'run_command':
      return `Run: ${call.body}`;
    case 'read_terminal':
      return call.args.lines ? `Read terminal (last ${call.args.lines} lines)` : 'Read terminal';
  }
}

// ==========================================
// Conductor & Multi-Node Model Routing
// ==========================================

export function isEmbeddingModelName(name: string, capabilities?: string[]): boolean {
  const n = name.toLowerCase();
  if (n.includes('embed') || n.includes('bge-') || n.includes('bge:') || n.includes('mxbai')) return true;
  if (capabilities && capabilities.length === 1 && capabilities[0] === 'embedding') return true;
  return false;
}

/**
 * Returns only generative models on `node` that have NOT been switched off in `node.disabledModels`.
 * When the node is online, the live Ollama/Frontier catalog is authoritative — even if empty —
 * so deleted models (and seeded benchmarks) do not reappear in the Conductor dropdown.
 */
export function getEnabledModelsForNode(node?: EndpointNode): string[] {
  if (!node) return [];
  const disabled = new Set(node.disabledModels || []);
  const discovered = (node.models || [])
    .filter(m => !isEmbeddingModelName(m.name, m.capabilities) && !disabled.has(m.name))
    .map(m => m.name);

  // Online = we successfully polled tags/models; trust that list (empty means none installed)
  if (node.online) return discovered;

  if (discovered.length > 0) return discovered;

  // Offline / not yet polled: soft hints only (never invent models for an online empty node)
  const benchKeys = Object.keys(node.benchmarks || {}).filter(k => !isEmbeddingModelName(k) && !disabled.has(k));
  if (benchKeys.length > 0) return benchKeys;
  if (node.activeModel && !disabled.has(node.activeModel)) return [node.activeModel];
  return [];
}

/**
 * Respects the user's chosen active model on a given node, falling back to the first enabled model on that node.
 * Online nodes with an empty catalog return '' (no ghost model names).
 */
export function getPreferredModelForNode(node?: EndpointNode, fallbackModel?: string): string {
  if (!node) return fallbackModel || 'qwen2.5-coder:7b';
  const enabled = getEnabledModelsForNode(node);
  if (enabled.length > 0) {
    if (node.activeModel && enabled.includes(node.activeModel)) return node.activeModel;
    if (fallbackModel && enabled.includes(fallbackModel)) return fallbackModel;
    return enabled[0];
  }
  if (node.online) return '';
  return node.activeModel || fallbackModel || 'qwen2.5-coder:7b';
}

function byCapacity(a: EndpointNode, b: EndpointNode): number {
  const score = (n: EndpointNode) =>
    (n.hardware?.vramGB || 0) * 10 + (n.hardware?.gpuBandwidthGBs || 0);
  return score(b) - score(a);
}

function nodeHasRole(n: EndpointNode, role: string): boolean {
  if (n.roles?.includes(role as any)) return true;
  const id = (n.id || '').toLowerCase();
  const name = (n.name || '').toLowerCase();
  if (role === 'reviewer') return id.includes('laptop') || name.includes('laptop') || name.includes('review');
  if (role === 'docs') return id.includes('linux') || id.includes('server') || name.includes('docs') || name.includes('server');
  if (role === 'coder' || role === 'planner') {
    return id.includes('main') || id.includes('rig') || name.includes('main') || (n.roles?.includes('coder') ?? false);
  }
  return false;
}

/**
 * Selects the best online hardware endpoint based on the task type and agent persona,
 * while strictly using only endpoints that have at least one enabled model.
 */
export function selectBestEndpointForTask(
  taskText: string,
  agentHandle: string,
  nodes: EndpointNode[]
): EndpointNode | undefined {
  if (!nodes.length) return undefined;
  const onlineLocal = nodes.filter(
    n => n.online && n.type !== 'openai' && getEnabledModelsForNode(n).length > 0
  );
  if (onlineLocal.length === 0) {
    return nodes.find(n => n.online) || nodes[0];
  }

  const lower = taskText.toLowerCase();
  const byRole = (role: string) => onlineLocal.filter(n => nodeHasRole(n, role)).sort(byCapacity);

  // Explicit agent persona routing (role tags first, legacy IDs as soft preference)
  if (agentHandle === 'reviewer') {
    const hits = byRole('reviewer');
    if (hits[0]) return hits[0];
  }
  if (agentHandle === 'docs') {
    const hits = byRole('docs');
    if (hits[0]) return hits[0];
  }

  // Task content routing when in auto-endpoint mode
  if (/\b(test|unit test|readme|document|docstring|comment)\b/.test(lower)) {
    const hits = byRole('docs');
    if (hits[0]) return hits[0];
  }
  if (/\b(review|lint|typo|css|style|color|format|quick)\b/.test(lower)) {
    const hits = byRole('reviewer');
    if (hits[0]) return hits[0];
  }

  const coderHits = byRole('coder');
  if (coderHits[0]) return coderHits[0];

  // Fallback to node with highest capacity
  return [...onlineLocal].sort(byCapacity)[0];
}

function isTinyModelName(name: string): boolean {
  return /:?(0\.5|1(\.5)?|1b|0\.5b)b?\b/i.test(name) || /tiny|mini:|smollm/i.test(name);
}

function conductorQualityBonus(model: string): number {
  const m = model.toLowerCase();
  let bonus = 0;
  if (/coder|instruct|code/.test(m)) bonus += 40;
  if (/7b|8b|9b|14b|32b|70b/.test(m)) bonus += 25;
  if (/3b|4b/.test(m)) bonus += 5;
  if (isTinyModelName(m)) bonus -= 50;
  return bonus;
}

function modelSpeed(n: EndpointNode, model: string): { speed: number; provisional: boolean } {
  const bm = n.benchmarks?.[model];
  if (bm?.evalTokPerSec) {
    return { speed: bm.evalTokPerSec, provisional: !!bm.provisional };
  }
  return { speed: Math.round((n.hardware?.gpuBandwidthGBs || 300) / 6), provisional: true };
}

/**
 * Finds the best Conductor model: prefer coder/instruct quality, then measured tok/s.
 */
export function findFastestConductor(
  nodes: EndpointNode[]
): { node: EndpointNode; model: string; tokPerSec: number } | null {
  const onlineLocal = nodes.filter(
    n => n.online && n.type !== 'openai' && getEnabledModelsForNode(n).length > 0
  );
  const pool = onlineLocal.length > 0 ? onlineLocal : nodes.filter(n => getEnabledModelsForNode(n).length > 0);
  if (pool.length === 0) return null;

  let bestNode = pool[0];
  let bestModel = getPreferredModelForNode(bestNode);
  let bestScore = -Infinity;
  let bestSpeed = 0;

  for (const n of pool) {
    const enabled = getEnabledModelsForNode(n);
    for (const m of enabled) {
      const { speed, provisional } = modelSpeed(n, m);
      // Live benchmarks beat provisional seeds; quality bonus biases planning models
      const score = conductorQualityBonus(m) * 1000 + speed + (provisional ? 0 : 500);
      if (score > bestScore) {
        bestScore = score;
        bestSpeed = speed;
        bestNode = n;
        bestModel = m;
      }
    }
  }

  return { node: bestNode, model: bestModel, tokPerSec: bestSpeed || 100 };
}

export interface ConductorFileJob {
  filePath: string;
  role: string;
  description: string;
  complexity: 'heavy' | 'medium' | 'light';
}

export function buildDecompositionPrompt(userTask: string, workspaceOverview: string): string {
  return `You are the Lead Conductor of a distributed multi-GPU coding cluster.
Break the user's software request into 2 to 4 distinct, concrete files that can be written in parallel by separate worker GPUs.

Rules:
- Output ONLY a valid JSON array of file objects. No markdown prose outside the JSON.
- Each object MUST have:
  "filePath": relative file path (e.g. "index.html", "styles.css", "app.js" OR for a native Windows app: "main.py", "ui_window.py", "run.bat")
  "role": short title (e.g. "Core Logic", "UI Layout", "Stylesheet", "Windows Launcher")
  "description": exact specification of what this file must export/contain and how it connects to the other files so they integrate seamlessly
  "complexity": "heavy" (main logic/UI), "medium" (structure/HTML/helpers), or "light" (CSS/launcher/config)
- For a Native Windows App request (unless C#/C++ is explicitly requested), prefer a self-contained Python Tkinter/ttk desktop GUI ("main.py", "app_logic.py", "run.bat") so it runs natively on Windows immediately without heavy compiler toolchains, or C# if requested.
- For a Webpage/Web App request, split into "index.html", "styles.css", and "app.js".

Workspace files:
${workspaceOverview}

User Request:
${userTask}

JSON Array:`;
}

export function fallbackDecomposeTask(userTask: string): ConductorFileJob[] {
  const lower = userTask.toLowerCase();

  // Native Windows / Desktop App fallback decomposition
  if (/\b(windows app|native app|desktop app|gui|tkinter|winforms|wpf|exe|calculator|notepad)\b/.test(lower)) {
    if (/\b(c#|csharp|winforms|wpf|\.net)\b/.test(lower)) {
      return [
        {
          filePath: 'MainForm.cs',
          role: 'Windows GUI & Controls (Heavy)',
          description: `Complete C# WinForms MainForm class implementing the UI and event handlers for: ${userTask}`,
          complexity: 'heavy'
        },
        {
          filePath: 'Program.cs',
          role: 'Application Entrypoint (Medium)',
          description: `C# STAThread Main entrypoint initializing ApplicationConfiguration and running MainForm for: ${userTask}`,
          complexity: 'medium'
        },
        {
          filePath: 'WinApp.csproj',
          role: 'Project Configuration (Light)',
          description: `.NET Windows Forms project file (<OutputType>WinExe</OutputType>, <UseWindowsForms>true</UseWindowsForms>) for: ${userTask}`,
          complexity: 'light'
        }
      ];
    }
    return [
      {
        filePath: 'main.py',
        role: 'Native Windows GUI & Event Loop (Heavy)',
        description: `Complete Python tkinter / ttk native Windows desktop application window, widgets, styling, and event bindings for: ${userTask}. Import helper logic from app_logic.py if needed, with safe fallback so it runs standalone.`,
        complexity: 'heavy'
      },
      {
        filePath: 'app_logic.py',
        role: 'Core State & Business Logic (Medium)',
        description: `Core data models, state management, file I/O, and helper functions imported by main.py for: ${userTask}.`,
        complexity: 'medium'
      },
      {
        filePath: 'run_app.bat',
        role: 'Windows Native Launcher (Light)',
        description: `Windows batch launcher (@echo off, python main.py, pause on error) to launch the native Windows app with double-click.`,
        complexity: 'light'
      }
    ];
  }

  // Default Web / Multi-file App decomposition
  return [
    {
      filePath: 'app.js',
      role: 'Application Logic & Interactivity (Heavy)',
      description: `Complete JavaScript logic, state, DOM event handlers, and rendering for: ${userTask}. Assumes index.html and styles.css are linked.`,
      complexity: 'heavy'
    },
    {
      filePath: 'index.html',
      role: 'HTML5 Document Structure (Medium)',
      description: `Complete HTML5 structure linking <link rel="stylesheet" href="styles.css"> and <script src="app.js"></script> for: ${userTask}.`,
      complexity: 'medium'
    },
    {
      filePath: 'styles.css',
      role: 'Modern Responsive Styling (Light)',
      description: `Complete modern CSS styling, dark/sleek theme, layout, and animations for the elements in index.html for: ${userTask}.`,
      complexity: 'light'
    }
  ];
}

const HAS_EXTENSION = /\.[a-zA-Z0-9]{1,8}$/;

export function parseConductorPlan(raw: string, userTask: string): ConductorFileJob[] {
  try {
    let cleaned = raw.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
    // Tolerate ```json ... ``` fences
    const fence = cleaned.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fence) cleaned = fence[1].trim();
    const start = cleaned.indexOf('[');
    const end = cleaned.lastIndexOf(']');
    if (start !== -1 && end > start) {
      const parsed = JSON.parse(cleaned.slice(start, end + 1));
      if (Array.isArray(parsed) && parsed.length > 0) {
        const seen = new Set<string>();
        const valid = parsed
          .filter(item => item && typeof item.filePath === 'string' && item.filePath.trim())
          .map(item => ({
            filePath: String(item.filePath).trim().replace(/^[\/\\]+/, '').replace(/\.\.[\/\\]+/g, ''),
            role: item.role || 'Module Implementation',
            description: item.description || `Implement ${item.filePath} for: ${userTask}`,
            complexity: (item.complexity === 'heavy' || item.complexity === 'medium' || item.complexity === 'light')
              ? item.complexity
              : 'medium' as const
          }))
          .filter(item => {
            if (!HAS_EXTENSION.test(item.filePath)) return false;
            const key = item.filePath.toLowerCase();
            if (seen.has(key)) return false;
            seen.add(key);
            return true;
          });
        if (valid.length > 0) return valid.slice(0, 6);
      }
    }
  } catch {
    // Fall back to deterministic decomposition
  }
  return fallbackDecomposeTask(userTask);
}

/**
 * Assigns decomposed file jobs across online local endpoints (never offline when any node is up).
 * Nodes ordered by measured tok/s of their preferred model, then bandwidth.
 */
export function assignJobsToCluster(
  jobs: ConductorFileJob[],
  nodes: EndpointNode[]
): { job: ConductorFileJob; node: EndpointNode; model: string; skippedReason?: string }[] {
  const onlineLocal = nodes.filter(
    n => n.online && n.type !== 'openai' && getEnabledModelsForNode(n).length > 0
  );
  // Never fall through to offline nodes when any online local exists
  const effectivePool = onlineLocal.length > 0
    ? onlineLocal
    : nodes.filter(n => n.online && getEnabledModelsForNode(n).length > 0);

  if (effectivePool.length === 0) {
    // Last resort: preferred models on configured nodes, mark reason for UI
    const any = nodes.filter(n => getEnabledModelsForNode(n).length > 0);
    const pool = any.length > 0 ? any : nodes;
    const weight = { heavy: 3, medium: 2, light: 1 };
    const sortedJobs = [...jobs].sort((a, b) => weight[b.complexity] - weight[a.complexity]);
    return sortedJobs.map((job, idx) => {
      const targetNode = pool[idx % pool.length];
      return {
        job,
        node: targetNode,
        model: getPreferredModelForNode(targetNode),
        skippedReason: targetNode.online ? undefined : 'Node offline — assignment may fail'
      };
    });
  }

  const sortedNodes = [...effectivePool].sort((a, b) => {
    const ma = getPreferredModelForNode(a);
    const mb = getPreferredModelForNode(b);
    const sa = modelSpeed(a, ma);
    const sb = modelSpeed(b, mb);
    // Prefer live (non-provisional) speeds, then raw speed, then bandwidth
    const scoreA = sa.speed + (sa.provisional ? 0 : 200) + (a.hardware?.gpuBandwidthGBs || 0) / 10;
    const scoreB = sb.speed + (sb.provisional ? 0 : 200) + (b.hardware?.gpuBandwidthGBs || 0) / 10;
    return scoreB - scoreA;
  });

  const weight = { heavy: 3, medium: 2, light: 1 };
  const sortedJobs = [...jobs].sort((a, b) => weight[b.complexity] - weight[a.complexity]);

  return sortedJobs.map((job, idx) => {
    const targetNode = sortedNodes[idx % sortedNodes.length];
    return {
      job,
      node: targetNode,
      model: getPreferredModelForNode(targetNode)
    };
  });
}
