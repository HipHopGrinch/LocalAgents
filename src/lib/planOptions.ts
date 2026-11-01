import { ApprovedPlan, ChatMessage, PlanOption } from '../types';

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
