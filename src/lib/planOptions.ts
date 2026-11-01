import { ApprovedPlan, ChatMessage, PlanOption, ReviewFixPlan, ReviewFixTask } from '../types';

/** Protocol appended to Planner system prompts so options are UI-parseable. */
export const PLANNER_PROTOCOL = `## Planner → Coder workflow (MANDATORY)

You are in **Planner mode**. Do NOT implement or write project files yet (no <write_file> / <edit_file> for the deliverable). You may use read_file, list_dir, and search to inspect the workspace.

### Intent bending
- Prefer matching the user's **delivery goal**, not a default stack.
- If they say "open in browser", "static site", "HTML page", or similar → bias toward static HTML/CSS/JS unless they explicitly ask for React/Vite/Next.
- If they ask for React/SPA/components → offer that as an option, not the only path.
- Ask **only** decisions that change architecture (stack, single-node vs Swarm, scope). Do not spam questions.

### Required output shape
1. Brief intent analysis (2–4 sentences) and assumptions.
2. A concrete proposed plan: phases and key files.
3. **2–4 numbered options** with short tradeoffs (e.g. static HTML vs React; Swarm vs single-node; minimal vs full scope).

You MUST end with a machine-readable block (prefer XML). Example:

<plan_options>
<option id="1" title="Static HTML store">Single index.html + CSS/JS; opens directly in the browser. Fastest path.</option>
<option id="2" title="React + Vite app">Componentized SPA; needs npm install/dev server. Better for growth.</option>
<option id="3" title="Static HTML via Swarm">Same static site, but parallel file workers if multi-file.</option>
</plan_options>

Also list the same options in human-readable markdown (Option 1 / Option 2 …). Wait for the user to pick before any implementation.`;

/** Protocol for Reviewer — findings + fix plan only; Planner then Coder apply changes. */
export const REVIEWER_PROTOCOL = `## Reviewer → Planner → Coder workflow (MANDATORY)

You are in **Reviewer mode**. Find bugs, security issues, edge cases, and missing behavior.
You may use read_file, list_dir, and search. Do NOT use <write_file> or <edit_file> — you do not patch the workspace yourself.

### First review (no durable task list yet)
1. Short findings (what is wrong, with file/line references when possible).
2. An **action plan** for Planner/Coder: ordered concrete fix tasks (file + what to change).
3. End with a machine-readable \`<review_plan>\` block. Planner owns this list afterward — it must not be replaced later.

Example (issues found):

<review_plan>
<summary>Hard drop and BGM toggle are broken; keyboard and HTML IDs disagree.</summary>
<task id="1" file="app.js" title="Fix hard drop">On Space, call hardDrop() instead of soft drop; keep repeat disabled for Space.</task>
<task id="2" file="index.html" title="Align BGM control id">Make the button id match the JS listener (bgm-toggle vs music-toggle).</task>
</review_plan>

Example (clean — no fix tasks):

<review_plan>
<summary>No blocking issues in the files just written.</summary>
</review_plan>

### Later reviews (durable task list already exists)
When the prompt shows a durable task list + an **active task**, do NOT emit a new <review_plan>.
Verify only the active task. End with:

<review_delta task_id="1">
<verdict>completed</verdict>
<notes>What was checked and why it passes (or what still fails).</notes>
</review_delta>

Use verdict \`failed\` when the active task is wrong or incomplete — tell Planner how to fix THAT task. Never invent a replacement task list.

Do not invent new features. Prefer 2–8 focused tasks on the first review. Do not write files.
After you have read what you need (at most a couple of **distinct** files), STOP reading and emit <review_plan> or <review_delta>. Never emit the same read_file path more than once. Prefer file contents already provided in the prompt.`;

/** Planner turn after Reviewer — lock contracts/tasks; no plan_options UI. */
export const REVIEW_FIX_CONTRACT_PROTOCOL = `## Planner contract-from-review (MANDATORY)

You received a **Reviewer fix plan**. You are NOT choosing architecture options.
Do NOT emit a <plan_options> block. Do NOT invent new features.

### Your job
1. Read relevant files if needed (do not re-read endlessly).
2. Lock a short **fix contract**: shared types, APIs, invariants, and which files change.
3. You MAY write a thin shared contract file (interfaces / SWARM.md notes only) — NOT full feature implementations.
4. End with a machine-readable \`<fix_contract>\` the UI hands to **Coder**. Coder is the only role that implements feature code.

<fix_contract>
<summary>One-line fix goal</summary>
<files>comma-separated paths Coder must touch</files>
<notes>Shared APIs / invariants / order of work for Coder</notes>
</fix_contract>

Keep the contract tight. Do not Apply feature edits yourself — Coder runs next.`;

const CLEAN_REVIEW =
  /\b(no (blocking )?issues|looks correct|review clean|nothing to fix|all good|no structured issues)\b/i;
const DIRTY_REVIEW =
  /\b(bug|bugs|issue|issues|inconsist|missing|broken|incorrect|failing|error|errors|should fix|need to fix|problem|problems|does not|doesn't|wrong)\b/i;

/** After user picks an architecture option — Planner locks ordered steps + tasks. */
export const EXECUTION_PLAN_LOCK_PROTOCOL = `## Planner lock execution plan (MANDATORY)

The user chose an architecture option. You are NOT implementing code and NOT emitting <plan_options>.
Break the chosen option into **ordered steps**. Each step has concrete coder tasks (file + what to change).

### Rules
1. 2–6 steps covering the whole chosen option (not a single mega-step).
2. Each step: 1–6 tasks with clear file targets when possible.
3. Do NOT write deliverable project files.
4. End with exactly one machine-readable \`<execution_plan>\` block.

<execution_plan>
<summary>One-line plan goal</summary>
<step id="1" title="Core types and rules">
<task id="1a" file="types.go" title="Define board types">Square and GameState matching the chosen approach.</task>
<task id="1b" file="game_logic.go" title="Move generation">Legal moves, captures, promotions.</task>
</step>
<step id="2" title="UI wiring">
<task id="2a" file="board_ui.go" title="Render board">Draw pieces and handle clicks.</task>
</step>
</execution_plan>

Coders will implement one step at a time. Reviewer will Yay/Nay each step. Do not invent later product features outside the chosen option.`;

/** Reviewer protocol when verifying a Planner step (Yay/Nay only). */
export const STEP_VERDICT_PROTOCOL = `## Reviewer step verdict (MANDATORY)

A durable Planner plan is active. You verify **one step** only.
Do NOT write or edit files.
Do NOT emit <review_plan>, <review_delta>, <plan_options>, or a new <execution_plan>.

### Reading rules
- Prefer file contents already included in the user prompt.
- At most **two** distinct read_file/list_dir/search calls total. Never emit the same path twice.
- After those reads (or immediately if files are already in the prompt), STOP exploring and emit the verdict.

End with:

<step_verdict step_id="1">
<result>yay</result>
<notes>What you checked and why the step passes.</notes>
</step_verdict>

OR

<step_verdict step_id="1">
<result>nay</result>
<notes>What is wrong and how Coders should fix THIS step.</notes>
</step_verdict>

yay = step tasks are done correctly. nay = send fix notes to Planner/Coders for the same step.`;

export interface ParsedExecutionPlan {
  summary: string;
  steps: Array<{
    id: string;
    title: string;
    description?: string;
    tasks: Array<{ id: string; title: string; description: string; file?: string }>;
  }>;
}

/** Parse \`<execution_plan>\` from Planner lock-plan reply. */
export function parseExecutionPlan(raw: string): ParsedExecutionPlan | null {
  const text = (raw || '').replace(/<think>[\s\S]*?<\/think>/gi, '');
  const block = text.match(/<execution_plan>([\s\S]*?)<\/execution_plan>/i)?.[1];
  if (!block) return null;
  const summary =
    block.match(/<summary>([\s\S]*?)<\/summary>/i)?.[1]?.replace(/\s+/g, ' ').trim() ||
    'Execution plan';
  const steps: ParsedExecutionPlan['steps'] = [];
  const stepRe = /<step\b([^>]*)>([\s\S]*?)<\/step>/gi;
  let sm: RegExpExecArray | null;
  let si = 0;
  while ((sm = stepRe.exec(block)) !== null) {
    si += 1;
    const attrs = sm[1] || '';
    const body = sm[2] || '';
    const id = /(?:^|\s)id\s*=\s*"([^"]*)"/i.exec(attrs)?.[1]?.trim() || String(si);
    const title =
      /(?:^|\s)title\s*=\s*"([^"]*)"/i.exec(attrs)?.[1]?.trim() || `Step ${id}`;
    const description =
      body.match(/<description>([\s\S]*?)<\/description>/i)?.[1]?.replace(/\s+/g, ' ').trim() ||
      undefined;
    const tasks: ParsedExecutionPlan['steps'][0]['tasks'] = [];
    const taskRe = /<task\b([^>]*)>([\s\S]*?)<\/task>/gi;
    let tm: RegExpExecArray | null;
    let ti = 0;
    while ((tm = taskRe.exec(body)) !== null) {
      ti += 1;
      const tAttrs = tm[1] || '';
      const tBody = (tm[2] || '').replace(/\s+/g, ' ').trim();
      const tid =
        /(?:^|\s)id\s*=\s*"([^"]*)"/i.exec(tAttrs)?.[1]?.trim() || `${id}${String.fromCharCode(96 + ti)}`;
      const file = /(?:^|\s)file\s*=\s*"([^"]*)"/i.exec(tAttrs)?.[1]?.trim();
      const tTitle =
        /(?:^|\s)title\s*=\s*"([^"]*)"/i.exec(tAttrs)?.[1]?.trim() ||
        (file ? `Work on ${file}` : `Task ${tid}`);
      if (!tBody && !tTitle) continue;
      tasks.push({
        id: tid,
        title: tTitle,
        description: tBody || tTitle,
        ...(file ? { file } : {})
      });
    }
    if (!tasks.length) {
      // Step with no nested tasks — treat body prose as one task
      const prose = body
        .replace(/<description>[\s\S]*?<\/description>/gi, '')
        .replace(/\s+/g, ' ')
        .trim();
      if (prose) {
        tasks.push({ id: `${id}a`, title, description: prose });
      }
    }
    if (!tasks.length) continue;
    steps.push({
      id,
      title,
      ...(description ? { description } : {}),
      tasks: tasks.slice(0, 8)
    });
  }
  if (!steps.length) return null;
  return { summary, steps: steps.slice(0, 8) };
}

export function stripExecutionPlanMarkup(text: string): string {
  return (text || '')
    .replace(/<execution_plan>[\s\S]*?<\/execution_plan>/gi, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Parse \`<step_verdict>\` Yay/Nay for a Planner step. */
export function parseStepVerdict(raw: string): {
  stepId: string;
  result: 'yay' | 'nay';
  notes: string;
} | null {
  const text = (raw || '').replace(/<think>[\s\S]*?<\/think>/gi, '');
  const m = text.match(/<step_verdict\b([^>]*)>([\s\S]*?)<\/step_verdict>/i);
  if (!m) return null;
  const attrs = m[1] || '';
  const body = m[2] || '';
  const stepId =
    /(?:^|\s)step_id\s*=\s*"([^"]*)"/i.exec(attrs)?.[1]?.trim() ||
    body.match(/<step_id>([\s\S]*?)<\/step_id>/i)?.[1]?.trim() ||
    '';
  const resultRaw = (
    body.match(/<result>([\s\S]*?)<\/result>/i)?.[1] ||
    body.match(/<verdict>([\s\S]*?)<\/verdict>/i)?.[1] ||
    ''
  )
    .toLowerCase()
    .trim();
  const notes = (
    body.match(/<notes>([\s\S]*?)<\/notes>/i)?.[1] || ''
  )
    .replace(/\s+/g, ' ')
    .trim();
  const yay = /\b(yay|yes|pass|passed|go|approve|approved|ok|good|complete|completed)\b/.test(
    resultRaw
  );
  const nay = /\b(nay|no|fail|failed|reject|rejected|no-?go|incomplete|wrong)\b/.test(resultRaw);
  if (!yay && !nay) {
    if (DIRTY_REVIEW.test(notes) && !CLEAN_REVIEW.test(notes)) {
      return { stepId, result: 'nay', notes: notes || 'Needs refining.' };
    }
    if (CLEAN_REVIEW.test(notes) || /\bpass|ok|looks good\b/i.test(notes)) {
      return { stepId, result: 'yay', notes: notes || 'Looks good.' };
    }
    return null;
  }
  return {
    stepId,
    result: nay && !yay ? 'nay' : yay ? 'yay' : 'nay',
    notes: notes || (nay && !yay ? 'Needs refining.' : 'Step looks good.')
  };
}

export function stripStepVerdictMarkup(text: string): string {
  return (text || '')
    .replace(/<step_verdict\b[^>]*>[\s\S]*?<\/step_verdict>/gi, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Parse \`<review_plan>\` from a reviewer reply. Empty tasks = clean review. */
export function parseReviewPlan(raw: string): ReviewFixPlan | null {
  const text = (raw || '').replace(/<think>[\s\S]*?<\/think>/gi, '');
  const block = text.match(/<review_plan>([\s\S]*?)<\/review_plan>/i)?.[1];
  if (!block) return null;
  const summary =
    block.match(/<summary>([\s\S]*?)<\/summary>/i)?.[1]?.replace(/\s+/g, ' ').trim() ||
    'Fix the issues found in review.';
  const tasks: ReviewFixTask[] = [];
  const taskRe = /<task\b([^>]*)>([\s\S]*?)<\/task>/gi;
  let m: RegExpExecArray | null;
  let i = 0;
  while ((m = taskRe.exec(block)) !== null) {
    i += 1;
    const attrs = m[1] || '';
    const body = (m[2] || '').replace(/\s+/g, ' ').trim();
    const id = /(?:^|\s)id\s*=\s*"([^"]*)"/i.exec(attrs)?.[1]?.trim() || String(i);
    const file = /(?:^|\s)file\s*=\s*"([^"]*)"/i.exec(attrs)?.[1]?.trim();
    const title =
      /(?:^|\s)title\s*=\s*"([^"]*)"/i.exec(attrs)?.[1]?.trim() ||
      (file ? `Fix ${file}` : `Task ${id}`);
    if (!body && !title) continue;
    tasks.push({ id, title, description: body || title, ...(file ? { file } : {}) });
  }
  return { summary, tasks: tasks.slice(0, 12) };
}

/** Parse \`<review_delta>\` — status update for one durable queue task. */
export function parseReviewDelta(raw: string): {
  taskId: string;
  verdict: 'completed' | 'failed';
  notes: string;
} | null {
  const text = (raw || '').replace(/<think>[\s\S]*?<\/think>/gi, '');
  const m = text.match(/<review_delta\b([^>]*)>([\s\S]*?)<\/review_delta>/i);
  if (!m) return null;
  const attrs = m[1] || '';
  const body = m[2] || '';
  const taskId =
    /(?:^|\s)task_id\s*=\s*"([^"]*)"/i.exec(attrs)?.[1]?.trim() ||
    body.match(/<task_id>([\s\S]*?)<\/task_id>/i)?.[1]?.trim() ||
    '';
  const verdictRaw = (
    body.match(/<verdict>([\s\S]*?)<\/verdict>/i)?.[1] || ''
  )
    .toLowerCase()
    .trim();
  const notes = (
    body.match(/<notes>([\s\S]*?)<\/notes>/i)?.[1] ||
    body.replace(/<\/?verdict>[\s\S]*?<\/verdict>/gi, '').replace(/\s+/g, ' ').trim()
  ).trim();
  const completed = /\b(complete|completed|pass|passed|done|ok|success)\b/.test(verdictRaw);
  const failed = /\b(fail|failed|incomplete|wrong|broken)\b/.test(verdictRaw);
  if (!completed && !failed) {
    if (DIRTY_REVIEW.test(notes) && !CLEAN_REVIEW.test(notes)) {
      return { taskId, verdict: 'failed', notes: notes || 'Reviewer marked failure.' };
    }
    if (CLEAN_REVIEW.test(notes) || /\bpass|ok|looks good\b/i.test(notes)) {
      return { taskId, verdict: 'completed', notes: notes || 'Looks good.' };
    }
    return null;
  }
  return {
    taskId,
    verdict: failed && !completed ? 'failed' : 'completed',
    notes: notes || (failed && !completed ? 'Not done correctly.' : 'Completed.')
  };
}

/** Strip review_delta markup from chat display. */
export function stripReviewDeltaMarkup(text: string): string {
  return (text || '')
    .replace(/<review_delta\b[^>]*>[\s\S]*?<\/review_delta>/gi, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * True when the model described problems but omitted <task> tags (false "clean").
 * Synthesize a single planner handoff task from the summary/display.
 */
export function coerceDirtyReviewPlan(
  plan: ReviewFixPlan | null | undefined,
  displayOrRaw: string
): ReviewFixPlan {
  const base = plan || { summary: 'Review findings need Planner/Coder follow-up.', tasks: [] };
  if (base.tasks.length > 0) return base;
  const text = `${base.summary}\n${displayOrRaw || ''}`.replace(/\s+/g, ' ').trim();
  if (!text || CLEAN_REVIEW.test(text)) return base;
  if (!DIRTY_REVIEW.test(text)) return base;
  const summary = base.summary && !CLEAN_REVIEW.test(base.summary)
    ? base.summary
    : text.slice(0, 280);
  return {
    summary,
    tasks: [
      {
        id: '1',
        title: 'Address review findings',
        description: summary
      }
    ]
  };
}

/** Strip review_plan markup from chat display. */
export function stripReviewPlanMarkup(text: string): string {
  return (text || '')
    .replace(/<review_plan>[\s\S]*?<\/review_plan>/gi, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Prompt for Planner after Send to Planner / Auto-review. */
export function formatReviewPlanForPlanner(plan: ReviewFixPlan, reviewDisplay?: string): string {
  const lines = plan.tasks.map((t, idx) => {
    const n = t.id || String(idx + 1);
    const where = t.file ? ` [\`${t.file}\`]` : '';
    return `${n}. ${t.title}${where}: ${t.description}`;
  });
  const findings = (reviewDisplay || '').trim().slice(0, 2500);
  return `## REVIEW FIX PLAN (from Reviewer — write the fix contract)

Summary: ${plan.summary}

Tasks:
${lines.join('\n')}

${findings ? `Reviewer notes (context):\n${findings}\n` : ''}
Produce a fix contract (shared types/APIs/files). You may write a contract file. End with <fix_contract>. Do NOT emit <plan_options>. Do NOT implement the full app fixes yourself — Coder runs next.`;
}

/** Prompt for Coder after Planner finishes the review-fix contract. */
export function formatReviewPlanForCoder(
  plan: ReviewFixPlan,
  reviewDisplay?: string,
  plannerBrief?: string
): string {
  const lines = plan.tasks.map((t, idx) => {
    const n = t.id || String(idx + 1);
    const where = t.file ? ` [\`${t.file}\`]` : '';
    return `${n}. ${t.title}${where}: ${t.description}`;
  });
  const findings = (reviewDisplay || '').trim().slice(0, 2000);
  const contract = (plannerBrief || '').trim().slice(0, 4000);
  return `## FIX CONTRACT + REVIEW TASKS (implement now)

${contract ? `### Planner contract\n${contract}\n` : ''}### Reviewer summary
${plan.summary}

### Tasks
${lines.join('\n')}

${findings ? `Reviewer notes:\n${findings}\n` : ''}
Honor the Planner contract. Use <edit_file> search/replace when possible; use <write_file> only when needed. Do not expand into unrelated features. Address every task above.`;
}

/** Strip <fix_contract> markup from Planner display. */
export function stripFixContractMarkup(text: string): string {
  return (text || '')
    .replace(/<fix_contract>[\s\S]*?<\/fix_contract>/gi, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Prefer <fix_contract> body; fall back to stripped planner reply. */
export function extractFixContractBrief(raw: string, display?: string): string {
  const text = (raw || '').replace(/<think>[\s\S]*?<\/think>/gi, '');
  const block = text.match(/<fix_contract>([\s\S]*?)<\/fix_contract>/i)?.[1]?.trim();
  if (block) {
    const summary = block.match(/<summary>([\s\S]*?)<\/summary>/i)?.[1]?.replace(/\s+/g, ' ').trim();
    const files = block.match(/<files>([\s\S]*?)<\/files>/i)?.[1]?.replace(/\s+/g, ' ').trim();
    const notes = block.match(/<notes>([\s\S]*?)<\/notes>/i)?.[1]?.replace(/\s+/g, ' ').trim();
    const parts = [
      summary ? `Goal: ${summary}` : '',
      files ? `Files: ${files}` : '',
      notes ? `Notes: ${notes}` : ''
    ].filter(Boolean);
    if (parts.length) return parts.join('\n');
    return block.replace(/\s+/g, ' ').trim().slice(0, 3000);
  }
  return stripFixContractMarkup(display || raw || '').slice(0, 3000);
}

/** Context injected when Coder executes a locked plan. */
export function formatApprovedPlanContext(plan: ApprovedPlan): string {
  return `## APPROVED PLAN (locked — do not re-plan unless the user asks)

Original request:
${plan.originalUserRequest}

Chosen option (#${plan.chosenOptionId}): ${plan.chosenOptionTitle}
${plan.chosenOptionDescription}

Plan:
${plan.planMarkdown || plan.summary}

Implement this option now. Use tool tags to write files. Match the chosen stack and scope exactly (e.g. static HTML if that was chosen — do not switch to React unless the option says so).`;
}

/**
 * Slim approved-plan text for Swarm Pass 1 (Lead Architect).
 * Intentionally omits full planMarkdown — that dump caused workers to echo
 * "Intent Analysis" into build.bat / headers.
 */
export function formatApprovedPlanForSwarm(plan: ApprovedPlan): string {
  const title = (plan.chosenOptionTitle || '').toLowerCase();
  const desc = (plan.chosenOptionDescription || '').toLowerCase();
  const blob = `${title} ${desc} ${plan.originalUserRequest || ''}`.toLowerCase();
  let stackHint =
    'Infer stack from the chosen option. Prefer HTML/CSS/JS for static sites; TypeScript contract workflow only when React/TypeScript was chosen.';
  if (/\b(c\+\+|cpp|win32|gdi|msvc|native)\b/.test(blob) && !/\belectron\b/.test(blob)) {
    stackHint =
      'Stack MUST be "native-win32". contractFile = "SWARM.md" (short shared notes in markdown, not TypeScript). Tasks: real .cpp/.h/.rc/.bat (or .cs) paths with concrete per-file instructions. Do NOT invent a TypeScript SPA.';
  } else if (/\b(static|html|css)\b/.test(blob) && !/\breact|typescript\b/.test(blob)) {
    stackHint =
      'Stack MUST be "static-web". Tasks like index.html, styles.css, app.js. Minimal or markdown contractFile — do NOT force React/TypeScript.';
  } else if (/\breact|typescript|\.tsx\b/.test(blob)) {
    stackHint = 'Stack "typescript" with a shared TypeScript contractFile is appropriate.';
  }

  return `APPROVED USER PLAN (already chosen — follow exactly):

Original request: ${plan.originalUserRequest}

Chosen option (#${plan.chosenOptionId}): ${plan.chosenOptionTitle}
${plan.chosenOptionDescription}

${stackHint}

Decompose into 2–4 parallel file tasks with SHORT, file-specific instructions (what that file must contain). Never paste planning essays, option lists, or Intent Analysis into contractCode or task instructions.`;
}

/** One-screen brief for Swarm workers — no planner essay. */
export function formatApprovedPlanBrief(plan: ApprovedPlan): string {
  return `Original request: ${plan.originalUserRequest}
Chosen option: ${plan.chosenOptionTitle} — ${plan.chosenOptionDescription}`;
}

function stripFencesAround(block: string): string {
  return block.replace(/^```[a-zA-Z0-9_-]*\s*/i, '').replace(/\s*```$/i, '').trim();
}

/** Remove structured option blocks from text shown in the chat bubble. */
export function stripPlanOptionMarkup(text: string): string {
  let out = text;
  out = out.replace(/<plan_options>[\s\S]*?<\/plan_options>/gi, '');
  out = out.replace(/```(?:json|xml)?\s*\{[\s\S]*?"options"\s*:\s*\[[\s\S]*?\][\s\S]*?\}\s*```/gi, '');
  return out.replace(/\n{3,}/g, '\n\n').trim();
}

function normalizeOption(raw: Partial<PlanOption>, index: number): PlanOption | null {
  const id = String(raw.id ?? index + 1).trim() || String(index + 1);
  const title = (raw.title || '').trim() || `Option ${id}`;
  const description = (raw.description || '').trim() || title;
  if (!title && !description) return null;
  return { id, title, description };
}

function parseXmlPlanOptions(text: string): PlanOption[] {
  const block = text.match(/<plan_options>([\s\S]*?)<\/plan_options>/i);
  if (!block) return [];
  const options: PlanOption[] = [];
  const re = /<option\b([^>]*)>([\s\S]*?)<\/option>/gi;
  let m: RegExpExecArray | null;
  let i = 0;
  while ((m = re.exec(block[1])) !== null) {
    const attrs: Record<string, string> = {};
    const attrRe = /(\w+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
    let a: RegExpExecArray | null;
    while ((a = attrRe.exec(m[1])) !== null) attrs[a[1]] = a[2] ?? a[3] ?? '';
    const opt = normalizeOption(
      {
        id: attrs.id || String(i + 1),
        title: attrs.title || '',
        description: (m[2] || attrs.description || '').trim()
      },
      i
    );
    if (opt) options.push(opt);
    i += 1;
  }
  return options;
}

function parseJsonPlanOptions(text: string): PlanOption[] {
  const fence = text.match(/```(?:json)?\s*(\{[\s\S]*?\})\s*```/i);
  const candidates = [fence?.[1], text].filter(Boolean) as string[];
  for (const cand of candidates) {
    const sliced = stripFencesAround(cand);
    const objMatch = sliced.match(/\{[\s\S]*"options"\s*:\s*\[[\s\S]*\][\s\S]*\}/);
    if (!objMatch) continue;
    try {
      const parsed = JSON.parse(objMatch[0]) as { options?: Array<Partial<PlanOption>> };
      if (!Array.isArray(parsed.options)) continue;
      return parsed.options
        .map((o, i) => normalizeOption(o, i))
        .filter((o): o is PlanOption => !!o)
        .slice(0, 4);
    } catch {
      /* try next */
    }
  }
  return [];
}

/** Fallback: markdown "Option 1: Title — desc" / "1. **Title** — desc" */
function parseMarkdownPlanOptions(text: string): PlanOption[] {
  const options: PlanOption[] = [];
  const re =
    /(?:^|\n)\s*(?:#{1,3}\s*)?(?:\*\*)?(?:Option\s*)?(\d)(?:\*\*)?[.):\-\s]+(?:\*\*)?([^\n*]{2,80}?)(?:\*\*)?(?:\s*(?:—|–|:|-)\s*|\s{2,}|\n\s*)([^\n]+)?/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const opt = normalizeOption(
      {
        id: m[1],
        title: m[2].replace(/\*\*/g, '').trim(),
        description: (m[3] || m[2]).replace(/\*\*/g, '').trim()
      },
      options.length
    );
    if (opt) options.push(opt);
    if (options.length >= 4) break;
  }
  return options;
}

/** Parse 2–4 plan options from a Planner assistant reply. */
export function parsePlanOptions(raw: string): PlanOption[] {
  if (!raw?.trim()) return [];
  const xml = parseXmlPlanOptions(raw);
  if (xml.length >= 2) return xml.slice(0, 4);
  const json = parseJsonPlanOptions(raw);
  if (json.length >= 2) return json.slice(0, 4);
  const md = parseMarkdownPlanOptions(raw);
  if (md.length >= 2) return md.slice(0, 4);
  // Accept a single parsed option only if XML/JSON explicitly provided one
  if (xml.length === 1) return xml;
  if (json.length === 1) return json;
  return md.slice(0, 4);
}

export function buildPlanSummary(raw: string, options: PlanOption[]): string {
  const stripped = stripPlanOptionMarkup(raw);
  if (stripped.length > 40) return stripped.slice(0, 4000);
  if (!options.length) return stripped;
  return (
    stripped +
    '\n\n' +
    options.map(o => `Option ${o.id}: ${o.title} — ${o.description}`).join('\n')
  ).trim();
}

/**
 * Match a user reply to a plan option: "1", "option 2", "go with the static site", title fragments.
 */
export function matchPlanOption(userText: string, options: PlanOption[]): PlanOption | null {
  if (!options.length) return null;
  const t = userText.trim().toLowerCase().replace(/[“”]/g, '"');
  if (!t) return null;

  const num =
    t.match(/^\s*(?:option\s*)?([1-4])\s*[.)]?\s*$/i) ||
    t.match(/^\s*(?:go\s+with\s+|choose\s+|pick\s+|select\s+)?(?:option\s*)?([1-4])\b/i) ||
    t.match(/\boption\s*([1-4])\b/i);
  if (num) {
    const id = num[1];
    return options.find(o => o.id === id) || options[Number(id) - 1] || null;
  }

  // Title / description fuzzy match (longest title wins)
  const scored = options
    .map(o => {
      const title = o.title.toLowerCase();
      const desc = o.description.toLowerCase();
      let score = 0;
      if (t.includes(title) && title.length >= 4) score += 100 + title.length;
      else {
        const words = title.split(/\s+/).filter(w => w.length > 3);
        const hits = words.filter(w => t.includes(w)).length;
        if (hits >= 2 || (hits === 1 && words.length === 1)) score += 40 + hits * 10;
      }
      if (desc.length > 12) {
        const key = desc.slice(0, 40);
        if (t.includes(key)) score += 20;
      }
      // Common shorthand
      if (/\bstatic\b/.test(t) && /\bstatic\b/.test(title + desc)) score += 25;
      if (/\breact\b/.test(t) && /\breact\b/.test(title + desc)) score += 25;
      if (/\bswarm\b/.test(t) && /\bswarm\b/.test(title + desc)) score += 25;
      if (/\bhtml\b/.test(t) && /\bhtml\b/.test(title + desc)) score += 15;
      return { o, score };
    })
    .filter(x => x.score > 0)
    .sort((a, b) => b.score - a.score);

  return scored[0]?.score >= 25 ? scored[0].o : null;
}

/** Last assistant message that still has unchosen plan options. */
export function findPendingPlanMessage(messages: ChatMessage[]): ChatMessage | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role !== 'assistant') continue;
    if (m.planOptions && m.planOptions.length > 0 && !m.selectedPlanOptionId) return m;
    // A newer assistant turn without pending options ends the plan-choice window
    break;
  }
  return null;
}

/** User request that triggered the pending plan (message before the proposal). */
export function findPlanOriginalRequest(
  messages: ChatMessage[],
  planMsg: ChatMessage
): string {
  const idx = messages.findIndex(m => m.id === planMsg.id);
  for (let i = idx - 1; i >= 0; i--) {
    if (messages[i].role === 'user' && !messages[i].chosenPlanOptionId) {
      return messages[i].display || messages[i].raw || '';
    }
  }
  return '';
}

export function buildApprovedPlan(
  planMsg: ChatMessage,
  option: PlanOption,
  originalUserRequest: string
): ApprovedPlan {
  return {
    summary: planMsg.planSummary || stripPlanOptionMarkup(planMsg.display || planMsg.raw || ''),
    planMarkdown: stripPlanOptionMarkup(planMsg.raw || planMsg.display || ''),
    chosenOptionId: option.id,
    chosenOptionTitle: option.title,
    chosenOptionDescription: option.description,
    allOptions: planMsg.planOptions || [option],
    originalUserRequest: originalUserRequest || planMsg.planSummary || '',
    approvedAt: Date.now()
  };
}
