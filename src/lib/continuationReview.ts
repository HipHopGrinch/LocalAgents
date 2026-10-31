import { EndpointNode, PlanOption } from '../types';
import { getEnabledModelsForNode, isFrontierNode } from './tools';
import { parsePlanOptions } from './planOptions';

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

export const CONTINUATION_REVIEW_SYSTEM = `You check a coding step that just finished. You do not write or edit files. You decide whether the app should keep implementing, or stop and ask the user.

You may use only these tools, and only if you need to verify files:
<list_dir path="."/>
<read_file path="relative/path"/>
<search query="text"/>

After any tool use, end with exactly one <next_step> block.

<next_step>
<decision>continue</decision>
<reason>one or two sentences</reason>
<task>One concrete next implementation step. Name the files. The coder must be able to do it without asking the user.</task>
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
- If Next is set, that is the step to run. Do not invent a different question.
- If the latest turn already tried Next, say what is still missing in one sentence. Do not ask the same question again.`;

export function pickReviewNode(
  nodes: EndpointNode[],
  avoidId?: string
): EndpointNode | undefined {
  const usable = nodes.filter(n => n.online && getEnabledModelsForNode(n).length > 0);
  const local = usable.filter(n => !isFrontierNode(n));
  const pool = local.length > 0 ? local : usable;
  if (!pool.length) return undefined;
  const other = pool.filter(n => n.id !== avoidId);
  const prefer = other.find(n =>
    n.roles?.includes('reviewer') || /laptop|review/i.test(`${n.name} ${n.id}`)
  );
  return prefer || other[0] || pool[0];
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
  capped?: boolean;
}): string {
  const plan = input.approvedPlanText?.trim()
    ? `Approved plan:\n${input.approvedPlanText.trim()}`
    : 'No locked plan. Judge only the latest user request.';
  const cap = input.capped
    ? '\n\nYou are out of automatic steps. Use decision ask or done. Do not use continue.'
    : '';
  const log = input.workLog?.trim()
    ? `\n\nWork log (do not repeat Done or Already asked; run Next if it is set):\n${input.workLog.trim()}`
    : '';
  return `${plan}${log}

Workspace (top level):
${input.workspaceOverview || '(empty or still loading)'}

Recent chat:
${input.recentTranscript || '(no prior messages)'}

Decide the next action now.${cap}`;
}
