import { EndpointNode, PlanOption } from '../types';
import { MODEL_CATALOG } from '../config/modelCatalog';
import { DEFAULT_MODEL_NUM_CTX, resolveModelNumCtx } from './contextSize';
import { parsePlanOptions } from './planOptions';
import { normTag, parseParams } from './recommender';
import { getEnabledModelsForNode, isFrontierNode, nodeAllowsRole } from './tools';
import { isDurableStep, isInspectionOnly } from './workLog';
import type { NodeRole } from '../types';

/** Extra coding steps the app may run without asking. Then it stops and shows choices. */
export const MAX_AUTO_CONTINUATIONS = 4;

export type NextDecision = 'continue' | 'ask' | 'done';

export interface NextStepDecision {
  decision: NextDecision;
  reason: string;
  /** Concrete work for the coder when decision is continue. */
  task: string;
  options: PlanOption[];
}

export const CONTINUATION_REVIEW_SYSTEM = `You decide the next coding step after work just finished. You do NOT patch files yourself — Coder applies changes from Planner contracts. Reviewer findings go to Planner, not to you as edits.

You may use these tools for inspection only:
<list_dir path="."/>
<read_file path="relative/path"/>
<search query="text"/>

Do NOT use <write_file> or <edit_file>. Do not Apply changes. After at most one round of reads, emit exactly one <next_step> block.

Reading is a tool inside this turn, never a <task>. Do not set <task> to "Read …", "Verify …", "Examine …", or "Check …". A <task> must name a file and a concrete change for Coder (fix, edit, wire, implement).

<next_step>
<decision>continue</decision>
<reason>one or two sentences</reason>
<task>One concrete fix or implementation step that edits or writes a named file. Not a read or verify.</task>
</next_step>

OR

<next_step>
<decision>ask</decision>
<reason>why the user has to choose</reason>
<plan_options>
<option id="1" title="Short title">What this choice builds.</option>
<option id="2" title="Short title">What this choice builds.</option>
</plan_options>
</next_step>

OR

<next_step>
<decision>done</decision>
<reason>why the requested work is finished</reason>
<plan_options>
<option id="1" title="Optional follow-up">A useful next feature, not required to finish the request.</option>
<option id="2" title="Optional follow-up">Another useful next feature.</option>
</plan_options>
</next_step>

Rules:
- continue when the approved plan or the latest request still has obvious unfinished work (missing file, broken command, incomplete feature) and you can name the next step.
- Do not continue into a new feature the user did not ask for.
- Do not repeat the step that just finished.
- ask only when two real directions remain and picking the wrong one would waste work.
- done when the chosen scope is in place. Still offer 2–3 optional next steps in <plan_options>.
- Prefer continue over ask. Automate anything that does not need a product decision.
- The work log is the source of truth. Never continue or ask a step listed under Done or Already asked.
- Prefer one concrete Coder task over another inspection pass.
- If Bug is set, that bug is the priority until a related file is edited or written.
- If Next is set and durable, that is the step to run. Do not invent a different question.
- If the latest turn already tried Next, say what is still missing in one sentence. Do not ask the same question again.
- Never continue with an inspection-only task.`;

/** Parameters the model actually runs. Catalog active size, else catalog size, else the tag. */
export function reviewModelSizeB(modelName: string): number {
  const row = MODEL_CATALOG.find(m => normTag(m.tag) === normTag(modelName));
  if (row) {
    if (typeof row.activeB === 'number' && row.activeB > 0) return row.activeB;
    if (typeof row.paramsB === 'number' && row.paramsB > 0) return row.paramsB;
  }
  return parseParams(modelName) ?? 0;
}

export interface ReviewTarget {
  node: EndpointNode;
  model: string;
}

/**
 * Strongest enabled local model for the after-step check.
 * Order: parameter size, then that model's num_ctx, then VRAM.
 * Only nodes that allow `role` (default reviewer) are considered — Allowed Roles is hard.
 * Frontier is only the pool when no local worker is online.
 */
export function pickCapableReviewTarget(
  nodes: EndpointNode[],
  role: NodeRole = 'reviewer'
): ReviewTarget | undefined {
  const usable = nodes.filter(
    n => n.online && getEnabledModelsForNode(n).length > 0 && nodeAllowsRole(n, role)
  );
  const local = usable.filter(n => !isFrontierNode(n));
  const pool = local.length > 0 ? local : usable;
  let best: ReviewTarget | undefined;
  let bestSize = -1;
  let bestCtx = -1;
  let bestVram = -1;
  for (const node of pool) {
    const vram = node.hardware?.vramGB || 0;
    for (const model of getEnabledModelsForNode(node)) {
      const size = reviewModelSizeB(model);
      const ctx = resolveModelNumCtx(node, model, DEFAULT_MODEL_NUM_CTX);
      const wins =
        size > bestSize ||
        (size === bestSize && ctx > bestCtx) ||
        (size === bestSize && ctx === bestCtx && vram > bestVram);
      if (!wins) continue;
      best = { node, model };
      bestSize = size;
      bestCtx = ctx;
      bestVram = vram;
    }
  }
  return best;
}

/** Largest enabled local model, then the card with the most VRAM. Used when a step is repeating. */
export function pickLargestLocalTarget(
  nodes: EndpointNode[],
  role: NodeRole = 'coder'
): ReviewTarget | undefined {
  const pool = nodes.filter(
    n =>
      n.online &&
      !isFrontierNode(n) &&
      getEnabledModelsForNode(n).length > 0 &&
      nodeAllowsRole(n, role)
  );
  let best: ReviewTarget | undefined;
  let bestSize = -1;
  let bestVram = -1;
  for (const node of pool) {
    const vram = node.hardware?.vramGB || 0;
    for (const model of getEnabledModelsForNode(node)) {
      const size = reviewModelSizeB(model);
      const wins = size > bestSize || (size === bestSize && vram > bestVram);
      if (!wins) continue;
      best = { node, model };
      bestSize = size;
      bestVram = vram;
    }
  }
  return best;
}

const FILE_NAME = /[A-Za-z0-9_.-]+\.(?:py|ts|tsx|js|jsx|json|md|html|css|go|rs)/g;
const FIX_LANGUAGE =
  /\b(fix|polish|bug|bugs|broken|repair|correct|missing|incomplete|does not|doesn't|fail|fails|failing|error|errors)\b/i;
const NEW_WORK = /\b(add|create|build|implement|introduce)\b/i;

function fileNamesIn(text: string): string[] {
  return [...text.matchAll(FILE_NAME)].map(m => m[0].toLowerCase());
}

function knownPaths(writtenPaths: string[]): Set<string> {
  const known = new Set<string>();
  for (const p of writtenPaths) {
    const norm = p.replace(/\\/g, '/').toLowerCase();
    known.add(norm);
    const base = norm.split('/').pop();
    if (base) known.add(base);
  }
  return known;
}

/** A continue that repairs the files just written stays on the review model. */
export function taskFixesWrittenFiles(task: string, writtenPaths: string[]): boolean {
  if (!task.trim() || writtenPaths.length === 0) return false;
  const known = knownPaths(writtenPaths);
  const named = fileNamesIn(task);
  const isKnown = (name: string) => known.has(name) || [...known].some(k => k.endsWith('/' + name));
  if (named.some(name => !isKnown(name))) return false;
  if (named.length > 0 && named.every(isKnown)) {
    if (NEW_WORK.test(task) && !FIX_LANGUAGE.test(task)) return false;
    return true;
  }
  return FIX_LANGUAGE.test(task);
}

export function collectWrittenPaths(
  messages: {
    role: string;
    toolCalls?: { name: string; args?: { path?: string } }[];
    pipelineSteps?: { targetFile?: string; toolCalls?: { name: string; args?: { path?: string } }[] }[];
  }[]
): string[] {
  let userIdx = messages.length - 1;
  while (userIdx >= 0 && messages[userIdx].role !== 'user') userIdx -= 1;
  const since = messages.slice(Math.max(0, userIdx));
  const paths: string[] = [];
  const push = (name: string | undefined, path: string | undefined) => {
    if ((name === 'write_file' || name === 'edit_file') && path) paths.push(path);
  };
  for (const message of since) {
    for (const tool of message.toolCalls || []) push(tool.name, tool.args?.path);
    for (const step of message.pipelineSteps || []) {
      if (step.targetFile) paths.push(step.targetFile);
      for (const tool of step.toolCalls || []) push(tool.name, tool.args?.path);
    }
  }
  return paths;
}

/**
 * Load recently touched files into the prompt so Reviewer/Planner do not need
 * to spam read_file for content the Studio already has on disk.
 */
export async function buildTouchedFilesContext(
  workspacePath: string | undefined,
  paths: string[],
  opts?: { maxFiles?: number; maxCharsPerFile?: number; maxTotalChars?: number }
): Promise<string> {
  if (!workspacePath || !paths.length || !window.electronAPI?.readFile) return '';
  const maxFiles = opts?.maxFiles ?? 8;
  const maxCharsPerFile = opts?.maxCharsPerFile ?? 6000;
  const maxTotalChars = opts?.maxTotalChars ?? 24000;
  const unique: string[] = [];
  const seen = new Set<string>();
  for (const raw of paths) {
    const p = (raw || '').replace(/\\/g, '/').trim();
    if (!p) continue;
    const key = p.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(p);
    if (unique.length >= maxFiles) break;
  }
  const chunks: string[] = [];
  let total = 0;
  for (const rel of unique) {
    if (total >= maxTotalChars) break;
    try {
      const isAbs = /^[a-zA-Z]:[\\/]/.test(rel) || rel.startsWith('/');
      const root = workspacePath.replace(/[\\/]+$/, '');
      const abs = isAbs ? rel : `${root}/${rel}`;
      const res = (await window.electronAPI.readFile(abs)) as {
        content?: string;
        error?: string;
      };
      if (!res?.content || res.error) continue;
      const room = Math.min(maxCharsPerFile, maxTotalChars - total);
      const body =
        res.content.length > room
          ? `${res.content.slice(0, room)}\n…(truncated)`
          : res.content;
      chunks.push(`### ${rel}\n\`\`\`\n${body}\n\`\`\``);
      total += body.length;
    } catch {
      /* ignore missing files */
    }
  }
  if (!chunks.length) return '';
  return `## Files already on disk (do NOT re-read these with read_file unless you need a different path)\n${chunks.join('\n\n')}`;
}

function innerTag(block: string, name: string): string {
  const m = block.match(new RegExp(`<${name}>\\s*([\\s\\S]*?)\\s*</${name}>`, 'i'));
  return (m?.[1] || '').trim();
}

export function stripNextStepMarkup(text: string): string {
  return text
    .replace(/<next_step>[\s\S]*?<\/next_step>/gi, '')
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function tasksTooSimilar(a: string, b: string): boolean {
  const norm = (s: string) => s.toLowerCase().replace(/\s+/g, ' ').trim();
  const na = norm(a);
  const nb = norm(b);
  if (!na || !nb) return false;
  if (na === nb) return true;
  const shorter = na.length < nb.length ? na : nb;
  const longer = na.length < nb.length ? nb : na;
  return shorter.length > 40 && longer.includes(shorter);
}

/**
 * Drop inspection-only continue tasks. Prefer a durable Bug/Next from the work log
 * when the model only asked to read or verify again.
 */
export function filterInspectionContinue(
  decision: NextStepDecision,
  fallbackDurable = ''
): NextStepDecision {
  if (decision.decision !== 'continue') return decision;
  if (!decision.task || (!isInspectionOnly(decision.task) && isDurableStep(decision.task))) {
    return decision;
  }
  const fallback = fallbackDurable.trim();
  if (fallback && isDurableStep(fallback)) {
    return {
      ...decision,
      task: fallback,
      reason: decision.reason || 'Inspection-only continue was replaced with the durable work-log step.'
    };
  }
  return {
    decision: 'ask',
    reason:
      decision.reason ||
      'Need a concrete fix step (edit or write a file), not another read/verify.',
    task: '',
    options: decision.options.length
      ? decision.options
      : [
          {
            id: '1',
            title: 'Apply a concrete file fix',
            description: fallback || 'Edit or write a specific file to fix the reported bug.'
          }
        ]
  };
}

/** Parse the checker's decision. Missing markup means do not auto-continue. */
export function parseNextStep(raw: string): NextStepDecision | null {
  const text = (raw || '').replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
  if (!text) return null;
  const block = text.match(/<next_step>([\s\S]*?)<\/next_step>/i)?.[1] || '';
  const options = parsePlanOptions(block || text);
  if (!block) {
    if (options.length >= 2) {
      return { decision: 'ask', reason: stripNextStepMarkup(text), task: '', options };
    }
    return null;
  }
  const word = (innerTag(block, 'decision') || block).toLowerCase();
  const decision: NextDecision = /\bcontinue\b/.test(word)
    ? 'continue'
    : /\bdone\b|\bcomplete\b/.test(word)
      ? 'done'
      : 'ask';
  const reason = innerTag(block, 'reason') || stripNextStepMarkup(text);
  const task = innerTag(block, 'task');
  if (decision === 'continue' && task.length < 8) {
    return {
      decision: options.length ? 'ask' : 'done',
      reason: reason || 'The next step was not specific enough to run automatically.',
      task: '',
      options
    };
  }
  return { decision, reason, task, options };
}

export function buildContinuationReviewPrompt(input: {
  approvedPlanText?: string;
  recentTranscript: string;
  workspaceOverview: string;
  workLog?: string;
  writtenPaths?: string[];
  capped?: boolean;
}): string {
  const plan = input.approvedPlanText?.trim()
    ? `Approved plan:\n${input.approvedPlanText.trim()}`
    : 'No locked plan. Judge only the latest user request.';
  const cap = input.capped
    ? '\n\nYou are out of automatic steps. Use decision ask or done. Do not use continue.'
    : '';
  const log = input.workLog?.trim()
    ? `\n\nWork log (Bug and durable Next are priority; do not repeat Done or Already asked; never continue with Read/Verify only):\n${input.workLog.trim()}`
    : '';
  const files = input.writtenPaths?.length
    ? `\n\nFiles just written (read these, then patch bugs in them with edit_file):\n${input.writtenPaths.join('\n')}`
    : '';
  return `${plan}${log}${files}

Workspace (top level):
${input.workspaceOverview || '(empty or still loading)'}

Recent chat:
${input.recentTranscript || '(no prior messages)'}

Decide the next action now.${cap}`;
}
