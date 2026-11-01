import { AgentPersona, ApprovedPlan, EndpointNode, NodeRole, ToolCall, ToolName } from '../types';
import {
  PLANNER_PROTOCOL,
  REVIEWER_PROTOCOL,
  REVIEW_FIX_CONTRACT_PROTOCOL,
  EXECUTION_PLAN_LOCK_PROTOCOL,
  STEP_VERDICT_PROTOCOL,
  formatApprovedPlanContext
} from './planOptions';
import { DELIVERY_POLICY, TOOLCHAIN_PLAYBOOK } from './deliveryIntent';

const NODE_ROLES: NodeRole[] = ['coder', 'reviewer', 'docs', 'planner'];

export const READ_ONLY_TOOLS: ToolName[] = ['read_file', 'list_dir', 'search', 'read_terminal'];
const ALL_TOOLS: ToolName[] = [
  'read_file',
  'list_dir',
  'search',
  'write_file',
  'edit_file',
  'run_command',
  'read_terminal',
  'web_search',
  'generate_image'
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

/**
 * Remove markdown wrapping code fences (e.g. ```json ... ```, ```python ... ```, ~~~ ... ~~~)
 * Handles both closed fences and unclosed fences where the model opened ``` inside <write_file>
 * but closed with </write_file> without a matching trailing ```.
 */
export function unfence(body: string): string {
  let b = body.replace(/^\r?\n/, '').replace(/\r?\n[ \t]*$/, '');

  // 1. Perfectly matched wrapping fence (``` or ~~~ with optional lang tag and trailing fence)
  const fullFence = b.match(/^\s*(`{3,}|~{3,})[^\r\n]*\r?\n([\s\S]*?)\r?\n\1\s*$/);
  if (fullFence) {
    return fullFence[2];
  }

  // 2. Model opened a fence at start (e.g. ```json or ```) inside <write_file>
  // but closed the tag without a matching closing fence (or trailing fence is missing)
  const openFence = b.match(/^\s*(`{3,}|~{3,})[a-zA-Z0-9_\-\+#]*[ \t]*\r?\n([\s\S]*)$/);
  if (openFence) {
    let inner = openFence[2];
    // Strip trailing fence if present
    inner = inner.replace(/\r?\n(`{3,}|~{3,})\s*$/, '');
    return inner;
  }

  // 3. Trailing unmatched fence
  b = b.replace(/\r?\n(`{3,}|~{3,})\s*$/, '');

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

  // A frontier reply often stops inside the last file, with no closing tag.
  // Closed tags are already placeholders, so the last remaining tag is the cutoff.
  if (!streaming) {
    const openRe = /<(write_file|edit_file)\b([^>]*)>/gi;
    let lastOpen: RegExpExecArray | null = null;
    let openMatch: RegExpExecArray | null;
    while ((openMatch = openRe.exec(work)) !== null) lastOpen = openMatch;
    if (lastOpen && lastOpen.index !== undefined) {
      const name = lastOpen[1].toLowerCase() as ToolName;
      const args = parseAttrs(lastOpen[2] || '');
      if (!args.path) {
        const fallbackPath = args.file || args.filename || args.target || args.name || expectedFilePath;
        if (fallbackPath) args.path = fallbackPath;
      }
      const rawBody = work.slice(lastOpen.index + lastOpen[0].length);
      if (args.path && rawBody.trim().length > 0) {
        found.push({ name, attrs: lastOpen[2] || '', body: rawBody });
        const idx = found.length - 1;
        work = `${work.slice(0, lastOpen.index)}\u0000${idx}\u0000`;
      }
    }
  }

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
    } else if (f.name === 'web_search') {
      body = unfence(f.body ?? '').trim();
      if (!args.query && body) args.query = body;
    } else if (f.name === 'generate_image') {
      body = unfence(f.body ?? '').trim();
      if (!args.prompt && body) args.prompt = body;
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

      // No language-default inventing (main.py from ```python). Path must be explicit
      // in the fence, surrounding prose, a file comment, or expectedFilePath from Swarm.
      if (detectedFilename && !expectedFilePath && !pathExplicit) {
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
          body: unfence(content),
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
  const normalized = body.replace(/\r\n/g, '\n');
  const blocks: { search: string; replace: string }[] = [];
  const re = /^<{5,9}\s*SEARCH[^\n]*\n([\s\S]*?)^={5,9}[ \t]*\n([\s\S]*?)^>{5,9}\s*REPLACE/gm;
  let m;
  while ((m = re.exec(normalized)) !== null) {
    blocks.push({
      search: m[1].replace(/\n$/, ''),
      replace: m[2].replace(/\n$/, '')
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

/** Collapse tabs, strip trailing spaces, drop CR — for Pass 2 matching. */
function normalizeLine(s: string): string {
  return s.replace(/\t/g, '  ').replace(/[ \t]+$/g, '');
}

/** Fallback: match ignoring leading/trailing whitespace on each line. Returns [startLine, endLine) or null. */
function fuzzyLineMatch(lines: string[], searchLines: string[]): [number, number] | null {
  const norm = (s: string) => s.trim();
  const target = searchLines.map(norm);
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

/** Pass 2: unique match after normalizing indent/EOL differences. */
function normalizedLineMatch(lines: string[], searchLines: string[]): [number, number] | null {
  const target = searchLines.map(normalizeLine);
  while (target.length && !target[0].trim()) target.shift();
  while (target.length && !target[target.length - 1].trim()) target.pop();
  if (!target.length) return null;
  const hits: number[] = [];
  for (let i = 0; i + target.length <= lines.length; i++) {
    let ok = true;
    for (let j = 0; j < target.length; j++) {
      if (normalizeLine(lines[i + j]) !== target[j]) {
        ok = false;
        break;
      }
    }
    if (ok) hits.push(i);
  }
  return hits.length === 1 ? [hits[0], hits[0] + target.length] : null;
}

function lineSimilarity(a: string, b: string): number {
  const x = normalizeLine(a).trim();
  const y = normalizeLine(b).trim();
  if (x === y) return 1;
  if (!x.length && !y.length) return 1;
  if (!x.length || !y.length) return 0;
  const max = Math.max(x.length, y.length);
  let dist = 0;
  const n = Math.min(x.length, y.length);
  for (let i = 0; i < n; i++) if (x[i] !== y[i]) dist++;
  dist += Math.abs(x.length - y.length);
  return Math.max(0, 1 - dist / max);
}

/**
 * Pass 3: first/last two non-empty lines as anchors; require ~85% average line similarity
 * across a window of the same length.
 */
function anchorLineMatch(lines: string[], searchLines: string[]): [number, number] | null {
  const target = [...searchLines];
  while (target.length && !target[0].trim()) target.shift();
  while (target.length && !target[target.length - 1].trim()) target.pop();
  if (target.length < 2) return null;
  const head = target.slice(0, Math.min(2, target.length)).map(l => normalizeLine(l).trim());
  const tail = target.slice(-Math.min(2, target.length)).map(l => normalizeLine(l).trim());
  const len = target.length;
  const hits: number[] = [];
  for (let i = 0; i + len <= lines.length; i++) {
    const windowHead = lines.slice(i, i + head.length).map(l => normalizeLine(l).trim());
    const windowTail = lines.slice(i + len - tail.length, i + len).map(l => normalizeLine(l).trim());
    if (windowHead.some((l, j) => l !== head[j])) continue;
    if (windowTail.some((l, j) => l !== tail[j])) continue;
    let score = 0;
    for (let j = 0; j < len; j++) score += lineSimilarity(lines[i + j], target[j]);
    if (score / len >= 0.85) hits.push(i);
  }
  return hits.length === 1 ? [hits[0], hits[0] + len] : null;
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
    // Pass 1: exact
    const count = countOccurrences(text, search);
    if (count === 1) {
      text = text.replace(search, () => replace);
      continue;
    }
    if (count > 1) {
      return { applied: i, error: `Block ${i + 1}: SEARCH text matches ${count} places. Include more surrounding lines so it is unique.` };
    }
    const lines = text.split('\n');
    const searchLines = search.split('\n');
    // Pass 2: normalized indent/EOL
    let range = normalizedLineMatch(lines, searchLines);
    // Pass 2b: trim-only fuzzy (existing)
    if (!range) range = fuzzyLineMatch(lines, searchLines);
    // Pass 3: anchor + similarity
    if (!range) range = anchorLineMatch(lines, searchLines);
    if (!range) {
      return {
        applied: i,
        error: `Block ${i + 1}: SEARCH text not found in the file. Re-read the file with read_file, or emit the full file with <write_file path="...">.`
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

**Execution host:** Every tool below runs on the **Dev node** PC (where LocalAgents Studio and the open workspace live)—not on a remote GPU/inference host. \`run_command\`, pip/npm/winget installs, and the PowerShell terminal always target that Dev machine.

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

### 4. Run PowerShell Commands (on the Dev / Studio PC):
Commands execute in PowerShell on the Dev node workspace machine (Studio host), never on a remote Ollama GPU box:
<run_command>npm test</run_command>

### 5. Monitor the IDE Terminal (self-correct):
Read recent PowerShell output from the LocalAgents terminal panel on the Dev PC (includes commands the user ran and prior agent runs):
<read_terminal/>
<read_terminal lines="60"/>

When a command fails (non-zero exit), diagnose from the output, fix with <edit_file> or <write_file>, then re-run with <run_command>. Prefer <read_terminal/> if the user already ran something in the terminal and you need that output.

### 6. Web search (SearXNG):
<web_search query="rust cargo add tokio"/>

### 7. Generate an image into the workspace (the app picks an image-capable GPU automatically):
<generate_image path="assets/product.png" prompt="studio photo of a red sneaker on white"/>

### Mandatory Rules:
- MANDATORY: When the user asks you to build, create, or write code (e.g. "build a webpage", "create a python script"), you MUST invoke <write_file path="...">. DO NOT respond only with conversational text and raw markdown code blocks. The user expects the file to be created on their computer.
- After writing code that should be verified, run a relevant command (<run_command>) and fix failures from the terminal output before stopping.
- Paths are relative to the workspace root. Do not prefix with leading slash.
- State a brief 1-2 sentence description before or after the tool tags.`;

export interface BuildSystemPromptOptions {
  /** Planner turn: force plan+options protocol; skip write-heavy pressure */
  planMode?: boolean;
  /** Reviewer turn: findings + review_plan only; no workspace writes */
  reviewMode?: boolean;
  /** After review: Planner locks fix contract (writes allowed; no plan_options) */
  contractMode?: boolean;
  /** After option pick: Planner emits <execution_plan> steps+tasks */
  lockPlanMode?: boolean;
  /** Reviewer Yay/Nay on active Planner step */
  stepVerdictMode?: boolean;
  /** Locked plan after user picked an option */
  approvedPlan?: ApprovedPlan | null;
  /** Done steps and the next step. Survives a compacted chat. */
  progressLog?: string;
  /** Cluster nodes — used to inject Dev-host context */
  nodes?: EndpointNode[];
  /** Node currently running inference (may differ from Dev) */
  inferenceNodeId?: string;
}

export function buildSystemPrompt(
  agent: AgentPersona,
  workspace: string,
  overview: string,
  opts?: BuildSystemPromptOptions
): string {
  const contractMode = !!opts?.contractMode;
  const lockPlanMode = !!opts?.lockPlanMode;
  const stepVerdictMode = !!opts?.stepVerdictMode;
  const planMode =
    contractMode || lockPlanMode
      ? false
      : (opts?.planMode ?? (agent.handle === 'planner' || agent.id === 'planner'));
  const reviewMode =
    contractMode || lockPlanMode || stepVerdictMode
      ? stepVerdictMode
      : (opts?.reviewMode ?? (agent.handle === 'reviewer' || agent.id === 'reviewer'));
  const parts = [
    agent.systemPrompt.trim(),
    `## Environment
- Host OS: Windows (PowerShell)
- Workspace root: ${workspace || '(no folder open)'}
- Date: ${new Date().toISOString().slice(0, 10)}`
  ];
  if (opts?.nodes?.length) {
    parts.push(buildDevHostPromptSection(opts.nodes, opts.inferenceNodeId));
  }
  if (lockPlanMode) {
    parts.push(EXECUTION_PLAN_LOCK_PROTOCOL);
    if (agent.toolsEnabled) {
      parts.push(
        TOOL_PROTOCOL +
          '\n\n### Lock-plan restriction\nDo NOT use <write_file> or <edit_file> for deliverables. Emit <execution_plan> only.'
      );
    }
  } else if (stepVerdictMode) {
    parts.push(STEP_VERDICT_PROTOCOL);
    if (agent.toolsEnabled) {
      parts.push(
        TOOL_PROTOCOL +
          '\n\n### Step-verdict restriction\nDo NOT use <write_file> or <edit_file>. Emit <step_verdict> yay/nay only.'
      );
    }
  } else if (contractMode) {
    parts.push(REVIEW_FIX_CONTRACT_PROTOCOL);
    if (agent.toolsEnabled) {
      parts.push(
        TOOL_PROTOCOL +
          '\n\n### Contract-from-review\nYou may write/edit a shared contract file. Do not implement the full review fix list — Coder does that next. No <plan_options>.'
      );
      parts.push(DELIVERY_POLICY);
    }
  } else if (planMode) {
    parts.push(PLANNER_PROTOCOL);
    // Read tools only in plan mode — still document protocol but remind not to write deliverables
    if (agent.toolsEnabled) {
      parts.push(
        TOOL_PROTOCOL +
          '\n\n### Planner restriction\nDo NOT use <write_file> or <edit_file> for the deliverable. Exploration tools only until the user picks an option.'
      );
    }
  } else if (reviewMode) {
    parts.push(REVIEWER_PROTOCOL);
    if (agent.toolsEnabled) {
      parts.push(
        TOOL_PROTOCOL +
          '\n\n### Reviewer restriction\nDo NOT use <write_file> or <edit_file>. Exploration tools only. Produce a <review_plan> for Send to Planner.'
      );
    }
  } else {
    if (agent.toolsEnabled) {
      parts.push(TOOL_PROTOCOL);
      parts.push(DELIVERY_POLICY);
      parts.push(TOOLCHAIN_PLAYBOOK);
    }
    if (opts?.approvedPlan) parts.push(formatApprovedPlanContext(opts.approvedPlan));
  }
  if (opts?.progressLog?.trim()) {
    parts.push(`## Work log
This is the memory of the task. Trust it after a compacted chat. Do the Next step. Do not redo Done steps. Do not ask a question listed under Already asked.
${opts.progressLog.trim()}`);
  }
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
    case 'web_search':
      return `Search web: ${call.args.query || call.body || ''}`;
    case 'generate_image':
      return `Image ${call.args.path || 'asset'}: ${call.args.prompt || call.body || ''}`;
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
  if (!node) return '';
  const enabled = getEnabledModelsForNode(node);
  if (enabled.length === 0) return '';
  if (node.activeModel && enabled.includes(node.activeModel)) return node.activeModel;
  if (fallbackModel && enabled.includes(fallbackModel)) return fallbackModel;
  return enabled[0];
}

export function isFrontierNode(n?: EndpointNode): boolean {
  if (!n) return false;
  return n.type === 'openai' || !!n.apiKey;
}

/** The reply opened a file tag and never closed it (typical of a capped frontier stream). */
export function hasUnclosedWrite(text: string): { name: 'write_file' | 'edit_file'; path: string } | null {
  const opens = [...text.matchAll(/<(write_file|edit_file)\b([^>]*)>/gi)];
  const closes = (text.match(/<\/(?:write_file|edit_file)>/gi) || []).length;
  if (opens.length <= closes) return null;
  const last = opens[opens.length - 1];
  const attrs = last[2] || '';
  const path =
    /(?:path|file|filename|target|name)\s*=\s*"([^"]*)"/i.exec(attrs)?.[1] ||
    /(?:path|file|filename|target|name)\s*=\s*'([^']*)'/i.exec(attrs)?.[1] ||
    'file';
  return { name: last[1].toLowerCase() as 'write_file' | 'edit_file', path };
}

/** Point an absolute or missing write path at the file this worker was assigned. */
export function anchorWritePath(tool: ToolCall, expectedFilePath?: string): ToolCall {
  if (tool.name !== 'write_file' && tool.name !== 'edit_file') return tool;
  const p = (tool.args?.path || '').trim();
  const outside =
    !p ||
    /^[a-zA-Z]:[\\/]/.test(p) ||
    p.startsWith('/') ||
    p.startsWith('\\\\') ||
    /(^|[\\/])\.\.([\\/]|$)/.test(p);
  if (outside && expectedFilePath) {
    return { ...tool, args: { ...tool.args, path: expectedFilePath } };
  }
  return tool;
}

function byCapacity(a: EndpointNode, b: EndpointNode): number {
  const score = (n: EndpointNode) =>
    (n.hardware?.vramGB || 0) * 10 + (n.hardware?.gpuBandwidthGBs || 0);
  return score(b) - score(a);
}

type RoleBearing = { id?: string; name?: string; roles?: NodeRole[] };

export const ALL_NODE_ROLES: NodeRole[] = [...NODE_ROLES];

/** True when the node has no allow-list (Auto — all roles). */
export function isRoleAuto(n: RoleBearing): boolean {
  return !n.roles?.length;
}

/** Sanitize + dedupe a roles array; empty → undefined (Auto). */
export function sanitizeAllowedRoles(roles?: NodeRole[] | null): NodeRole[] | undefined {
  if (!roles?.length) return undefined;
  const seen = new Set<NodeRole>();
  const out: NodeRole[] = [];
  for (const r of roles) {
    if (!NODE_ROLES.includes(r) || seen.has(r)) continue;
    seen.add(r);
    out.push(r);
  }
  return out.length ? out : undefined;
}

/**
 * First allowed role when restricted; undefined = Auto.
 * Prefer nodeAllowsRole / nodeHasExplicitRole for routing.
 */
export function getPreferredRole(n: RoleBearing): NodeRole | undefined {
  const cleaned = sanitizeAllowedRoles(n.roles);
  return cleaned?.[0];
}

/** Node is Auto or its allow-list includes this role. */
export function nodeAllowsRole(n: RoleBearing, role: string): boolean {
  if (!NODE_ROLES.includes(role as NodeRole)) return false;
  if (isRoleAuto(n)) return true;
  return n.roles!.includes(role as NodeRole);
}

/** Restricted allow-list that includes this role (not Auto). */
export function nodeHasExplicitRole(n: RoleBearing, role: string): boolean {
  if (isRoleAuto(n)) return false;
  return n.roles!.includes(role as NodeRole);
}

function clearRoles<T extends RoleBearing>(n: T): T {
  if (!n.roles?.length) return n;
  const { roles: _drop, ...rest } = n;
  return rest as T;
}

/** Dedupe/clamp invalid role entries; empty → Auto. No exclusivity across nodes. */
export function normalizePreferredRoles<T extends RoleBearing>(nodes: T[]): T[] {
  return nodes.map(n => {
    const cleaned = sanitizeAllowedRoles(n.roles);
    if (!cleaned) return clearRoles(n);
    if (
      n.roles?.length === cleaned.length &&
      n.roles.every((r, i) => r === cleaned[i])
    ) {
      return n;
    }
    return { ...n, roles: cleaned };
  });
}

/** Set allowed roles on one node. Empty/null → Auto. Other nodes unchanged. */
export function assignAllowedRoles<T extends RoleBearing>(
  nodes: T[],
  nodeId: string,
  roles: NodeRole[] | null | ''
): T[] {
  const cleaned =
    roles === '' || roles === null ? undefined : sanitizeAllowedRoles(roles);
  return nodes.map(n => {
    if (n.id !== nodeId) return n;
    if (!cleaned) return clearRoles(n);
    return { ...n, roles: cleaned };
  });
}

/**
 * @deprecated Use assignAllowedRoles. Kept for single-role callers.
 * Assign one preferred role (or Auto); does not clear the role from other nodes.
 */
export function assignPreferredRole<T extends RoleBearing>(
  nodes: T[],
  nodeId: string,
  role: NodeRole | ''
): T[] {
  return assignAllowedRoles(nodes, nodeId, role ? [role] : null);
}

/** @deprecated Roles are no longer exclusive across nodes. */
export function findNodeHoldingRole(
  _nodes: RoleBearing[],
  _role: NodeRole,
  _exceptNodeId?: string
): { id: string; name: string } | undefined {
  return undefined;
}

// ==========================================
// Dev node (workspace + installs + terminal)
// ==========================================

type DevBearing = {
  id?: string;
  name?: string;
  url?: string;
  type?: 'ollama' | 'openai';
  apiKey?: string;
  isDevNode?: boolean;
};

/** True for URLs that look like Ollama on the Studio PC (localhost / loopback). */
export function isLikelyStudioLocalUrl(url?: string): boolean {
  if (!url) return false;
  try {
    const h = new URL(url).hostname.toLowerCase();
    return h === 'localhost' || h === '127.0.0.1' || h === '::1' || h === '[::1]';
  } catch {
    return /localhost|127\.0\.0\.1|\[::1\]/i.test(url);
  }
}

export function getDevNode<T extends DevBearing>(nodes: T[]): T | undefined {
  return nodes.find(n => n.isDevNode);
}

export function findNodeHoldingDev(
  nodes: DevBearing[],
  exceptNodeId?: string
): { id: string; name: string } | undefined {
  const hit = nodes.find(n => n.isDevNode && n.id && n.id !== exceptNodeId);
  if (!hit?.id) return undefined;
  return { id: hit.id, name: hit.name || hit.id };
}

/** At most one Dev node (first wins). */
export function normalizeDevNodes<T extends DevBearing>(nodes: T[]): T[] {
  let seen = false;
  return nodes.map(n => {
    if (!n.isDevNode) return n;
    if (seen) {
      const { isDevNode: _d, ...rest } = n;
      return rest as T;
    }
    seen = true;
    return { ...n, isDevNode: true };
  });
}

/** Mark one node as Dev; clear the flag from every other node. Pass enabled=false to clear. */
export function assignDevNode<T extends DevBearing>(
  nodes: T[],
  nodeId: string,
  enabled: boolean
): T[] {
  return nodes.map(n => {
    if (n.id === nodeId) {
      if (!enabled) {
        if (!n.isDevNode) return n;
        const { isDevNode: _d, ...rest } = n;
        return rest as T;
      }
      return { ...n, isDevNode: true };
    }
    if (enabled && n.isDevNode) {
      const { isDevNode: _d, ...rest } = n;
      return rest as T;
    }
    return n;
  });
}

/**
 * If no Dev node is marked, prefer a localhost/loopback non-frontier node.
 * Does not invent a Dev flag when only remote/frontier endpoints exist.
 */
export function ensureDevNode<T extends DevBearing>(nodes: T[]): T[] {
  const normalized = normalizeDevNodes(nodes);
  if (normalized.some(n => n.isDevNode)) return normalized;
  const local = normalized.find(
    n => isLikelyStudioLocalUrl(n.url) && n.type !== 'openai' && !n.apiKey
  );
  if (!local?.id) return normalized;
  return assignDevNode(normalized, local.id, true);
}

/** Allowed Roles sanitize + Dev node interlocking in one pass (load/import/save). */
export function normalizeClusterNodes<T extends DevBearing & RoleBearing>(nodes: T[]): T[] {
  return ensureDevNode(normalizePreferredRoles(nodes));
}

/**
 * Prompt block: workspace / installs / terminal are on the Dev PC.
 * Inference workers remain full collaborative multimodal agents.
 */
export function buildDevHostPromptSection(
  nodes: DevBearing[],
  inferenceNodeId?: string
): string {
  const marked = getDevNode(nodes);
  const inferred =
    marked ||
    nodes.find(n => isLikelyStudioLocalUrl(n.url) && n.type !== 'openai' && !n.apiKey);
  const devName = inferred?.name?.trim() || inferred?.id || 'the Studio PC';
  const inference = inferenceNodeId
    ? nodes.find(n => n.id === inferenceNodeId)
    : undefined;
  const inferenceAway =
    !!inference &&
    !!inferred?.id &&
    inference.id !== inferred.id;

  const base = `## Development host (workspace & installs)
The open workspace, filesystem tools (\`read_file\`, \`write_file\`, \`edit_file\`, \`list_dir\`, \`search\`), PowerShell/\`run_command\`, pip/npm/winget installs, and the IDE terminal all execute on the **Dev node** PC: **${devName}** — that is where LocalAgents Studio is open and where the project runs.

You may be generating on a different GPU/API host. That does **not** limit your job: you are a full collaborative agent. Analyze screenshots and other images when provided, review code, answer questions, write docs, and emit tool tags for the Dev workspace. Report findings in chat. Do **not** assume packages, Python/Node, or the app runtime live on your inference hardware — never say "install on this laptop" or treat the GPU host as the project machine.`;

  if (!inferenceAway) return base;

  const inferName = inference?.name?.trim() || inference?.id || 'this inference node';
  return `${base}

You are currently inferring on **${inferName}**, which is not the Dev node. Keep generating code, reviews, docs, and vision analysis for the Dev workspace; filesystem and terminal side effects still land on **${devName}**.`;
}

/**
 * Soft Auto routing: name/id heuristics.
 * Restricted nodes only match listed roles; Auto nodes use heuristics.
 */
function nodeHasRole(n: EndpointNode, role: string): boolean {
  if (!isRoleAuto(n)) return nodeHasExplicitRole(n, role);
  const id = (n.id || '').toLowerCase();
  const name = (n.name || '').toLowerCase();
  if (role === 'reviewer') return id.includes('laptop') || name.includes('laptop') || name.includes('review');
  if (role === 'docs') return id.includes('linux') || id.includes('server') || name.includes('docs') || name.includes('server');
  if (role === 'coder' || role === 'planner') {
    return id.includes('main') || id.includes('rig') || name.includes('main');
  }
  return false;
}

/**
 * Prefer nodes that explicitly allow this role (frontier allowed, no local-first).
 * Otherwise soft-match Auto nodes on the local-first pool.
 */
function pickEndpointForRole(
  role: string,
  onlineUsable: EndpointNode[],
  localFirstPool: EndpointNode[]
): EndpointNode | undefined {
  const tagged = onlineUsable.filter(n => nodeHasExplicitRole(n, role)).sort(byCapacity);
  if (tagged[0]) return tagged[0];
  const soft = localFirstPool.filter(n => nodeHasRole(n, role)).sort(byCapacity);
  return soft[0];
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
  const onlineUsable = nodes.filter(n => n.online && getEnabledModelsForNode(n).length > 0);
  const onlineLocal = onlineUsable.filter(n => !isFrontierNode(n));
  // Local-first; frontier only when no local workers are available (soft / Auto path)
  const pool = onlineLocal.length > 0 ? onlineLocal : onlineUsable;
  if (pool.length === 0) {
    return nodes.find(n => n.online) || nodes[0];
  }

  const lower = taskText.toLowerCase();
  const byRole = (role: string) => pickEndpointForRole(role, onlineUsable, pool);

  /** Persona-locked: never fall through to a node that does not allow this role. */
  const pickForPersona = (role: NodeRole): EndpointNode | undefined => {
    const hit = byRole(role);
    if (hit) return hit;
    const allowed = pool.filter(n => nodeAllowsRole(n, role)).sort(byCapacity);
    return allowed[0];
  };

  // Explicit agent persona routing — hard stop on Allowed Roles (no coder fallthrough)
  if (agentHandle === 'planner') return pickForPersona('planner');
  if (agentHandle === 'reviewer') return pickForPersona('reviewer');
  if (agentHandle === 'docs') return pickForPersona('docs');
  if (agentHandle === 'coder') return pickForPersona('coder');

  // Task content routing when in auto-endpoint mode
  if (/\b(test|unit test|readme|document|docstring|comment)\b/.test(lower)) {
    const hit = pickForPersona('docs');
    if (hit) return hit;
  }
  if (/\b(review|lint|typo|css|style|color|format|quick)\b/.test(lower)) {
    const hit = pickForPersona('reviewer');
    if (hit) return hit;
  }

  const coderHit = pickForPersona('coder');
  if (coderHit) return coderHit;

  // Fallback to node with highest capacity among Auto / unrestricted
  return [...pool].sort(byCapacity)[0];
}

function isTinyModelName(name: string): boolean {
  return /:?(0\.5|1(\.5)?|1b|0\.5b)b?\b/i.test(name) || /tiny|mini:|smollm/i.test(name);
}

function modelParamBillions(model: string): number {
  const m = model.toLowerCase();
  const match = m.match(/(\d+(?:\.\d+)?)\s*b\b/);
  if (match) return parseFloat(match[1]);
  if (/gemini|gpt-4|claude|grok/i.test(m)) return 70; // treat frontier as high-capacity
  return 7;
}

function conductorQualityBonus(model: string): number {
  const m = model.toLowerCase();
  let bonus = 0;
  if (/coder|instruct|code/.test(m)) bonus += 40;
  if (/7b|8b|9b|14b|32b|70b/.test(m)) bonus += 25;
  if (/3b|4b/.test(m)) bonus += 5;
  if (isTinyModelName(m)) bonus -= 50;
  if (/gemini|gpt-4|claude|grok/i.test(m)) bonus += 35;
  return bonus;
}

function modelSpeed(n: EndpointNode, model: string): { speed: number; provisional: boolean } {
  const bm = n.benchmarks?.[model];
  if (bm?.evalTokPerSec) {
    return { speed: bm.evalTokPerSec, provisional: !!bm.provisional };
  }
  if (isFrontierNode(n)) {
    return { speed: 80, provisional: true };
  }
  return { speed: Math.round((n.hardware?.gpuBandwidthGBs || 300) / 6), provisional: true };
}

/** Score how well a model fits a file job complexity (higher = better). */
function scoreModelForComplexity(
  model: string,
  complexity: ConductorFileJob['complexity']
): number {
  const size = modelParamBillions(model);
  const quality = conductorQualityBonus(model);
  if (complexity === 'heavy') return quality * 10 + size * 6;
  if (complexity === 'medium') return quality * 6 + size * 3 + 15;
  // light: prefer snappy smaller/local-friendly models
  return quality * 2 + Math.max(0, 35 - size) + (/coder|instruct/i.test(model) ? 8 : 0);
}

/** Best enabled model on a node for this job type (respects activeModel as a soft preference). */
export function pickBestModelForComplexity(
  node: EndpointNode,
  complexity: ConductorFileJob['complexity']
): string {
  const enabled = getEnabledModelsForNode(node);
  if (!enabled.length) return getPreferredModelForNode(node);

  let best = enabled[0];
  let bestScore = -Infinity;
  for (const m of enabled) {
    const { speed, provisional } = modelSpeed(node, m);
    const activeBonus = node.activeModel === m ? 40 : 0;
    const score =
      scoreModelForComplexity(m, complexity) * 100 +
      speed +
      (provisional ? 0 : 60) +
      activeBonus;
    if (score > bestScore) {
      bestScore = score;
      best = m;
    }
  }
  return best;
}

/**
 * Finds the best Conductor (planner) model.
 * Explicit allowed role = Planner wins (frontier allowed). Otherwise local-first Auto.
 */
export function findFastestConductor(
  nodes: EndpointNode[]
): { node: EndpointNode; model: string; tokPerSec: number; usedFrontierBackup?: boolean } | null {
  const onlineUsable = nodes.filter(n => n.online && getEnabledModelsForNode(n).length > 0);
  const onlineLocal = onlineUsable.filter(n => !isFrontierNode(n));
  const explicitPlanners = onlineUsable.filter(n => nodeHasExplicitRole(n, 'planner'));
  const usedExplicitPlanner = explicitPlanners.length > 0;
  const usedFrontierBackup = !usedExplicitPlanner && onlineLocal.length === 0 && onlineUsable.length > 0;
  const pool = usedExplicitPlanner
    ? explicitPlanners
    : onlineLocal.length > 0
      ? onlineLocal
      : onlineUsable;
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

  return {
    node: bestNode,
    model: bestModel,
    tokPerSec: bestSpeed || 100,
    usedFrontierBackup
  };
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

export type ClusterAssignment = {
  job: ConductorFileJob;
  node: EndpointNode;
  model: string;
  skippedReason?: string;
  usedFrontierBackup?: boolean;
};

/**
 * Assigns file jobs across enabled online workers.
 * Local-first: uses only local Ollama nodes when any are online; frontier APIs are a backup
 * when no local GPUs are available. Picks the best enabled model per job complexity and
 * spreads load across nodes for parallelism.
 */
export function assignJobsToCluster(
  jobs: ConductorFileJob[],
  nodes: EndpointNode[]
): ClusterAssignment[] {
  const onlineUsable = nodes.filter(n => n.online && getEnabledModelsForNode(n).length > 0);
  const onlineLocal = onlineUsable.filter(n => !isFrontierNode(n));
  const onlineFrontier = onlineUsable.filter(isFrontierNode);
  const usedFrontierBackup = onlineLocal.length === 0 && onlineFrontier.length > 0;
  const pool = onlineLocal.length > 0 ? onlineLocal : onlineFrontier;

  const weight = { heavy: 3, medium: 2, light: 1 };
  const sortedJobs = [...jobs].sort((a, b) => weight[b.complexity] - weight[a.complexity]);

  if (pool.length === 0) {
    const any = nodes.filter(n => getEnabledModelsForNode(n).length > 0);
    const fallback = any.length > 0 ? any : nodes;
    if (fallback.length === 0) return [];
    return sortedJobs.map((job, idx) => {
      const targetNode = fallback[idx % fallback.length];
      return {
        job,
        node: targetNode,
        model: pickBestModelForComplexity(targetNode, job.complexity),
        skippedReason: targetNode?.online
          ? undefined
          : 'Node offline — assignment may fail',
        usedFrontierBackup: isFrontierNode(targetNode)
      };
    });
  }

  const loadCount = new Map<string, number>();
  for (const n of pool) loadCount.set(n.id, 0);

  return sortedJobs.map(job => {
    let bestNode = pool[0];
    let bestScore = -Infinity;

    for (const n of pool) {
      const model = pickBestModelForComplexity(n, job.complexity);
      const { speed, provisional } = modelSpeed(n, model);
      const load = loadCount.get(n.id) || 0;
      const capacity =
        (n.hardware?.vramGB || 8) * 12 + (n.hardware?.gpuBandwidthGBs || 300) / 8;
      // Soft role preference for coding-heavy nodes on heavy jobs
      const roleBonus =
        job.complexity === 'heavy' && nodeHasRole(n, 'coder')
          ? 120
          : job.complexity === 'light' && (nodeHasRole(n, 'reviewer') || nodeHasRole(n, 'docs'))
            ? 60
            : 0;
      const score =
        scoreModelForComplexity(model, job.complexity) * 1000 +
        speed * 2 +
        (provisional ? 0 : 250) +
        capacity +
        roleBonus -
        load * 900; // spread parallel work across GPUs

      if (score > bestScore) {
        bestScore = score;
        bestNode = n;
      }
    }

    const model = pickBestModelForComplexity(bestNode, job.complexity);
    loadCount.set(bestNode.id, (loadCount.get(bestNode.id) || 0) + 1);

    return {
      job,
      node: bestNode,
      model,
      skippedReason: usedFrontierBackup
        ? 'Frontier backup — no local Ollama nodes online'
        : undefined,
      usedFrontierBackup
    };
  });
}
