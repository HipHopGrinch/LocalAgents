import { PlanOption } from '../types';

/** Steps already taken, the one next step, and questions already asked. */
export interface WorkLog {
  request: string;
  done: string[];
  next: string;
  asked: string[];
}

const MAX_DONE = 40;
const MAX_ASKED = 24;

export function emptyWorkLog(): WorkLog {
  return { request: '', done: [], next: '', asked: [] };
}

export function workLogPath(root: string, conversationId: string): string {
  const sep = root.includes('\\') ? '\\' : '/';
  const safe = conversationId.replace(/[^\w.-]/g, '_');
  return `${root.replace(/[\\/]+$/, '')}${sep}.localagents${sep}progress${sep}${safe}.md`;
}

function oneLine(text: string, max = 220): string {
  return text.replace(/\s+/g, ' ').trim().slice(0, max);
}

function fileNames(text: string): string[] {
  return [...text.matchAll(/[A-Za-z0-9_.-]+\.(?:py|ts|tsx|js|jsx|json|md|html|css|go|rs)/g)].map(m =>
    m[0].toLowerCase()
  );
}

export function stepsTooSimilar(a: string, b: string): boolean {
  const na = oneLine(a, 500).toLowerCase();
  const nb = oneLine(b, 500).toLowerCase();
  if (!na || !nb) return false;
  if (na === nb) return true;
  const shorter = na.length < nb.length ? na : nb;
  const longer = na.length < nb.length ? nb : na;
  if (shorter.length > 18 && longer.includes(shorter)) return true;
  const fa = fileNames(a);
  const fb = new Set(fileNames(b));
  if (!fa.length || !fa.some(f => fb.has(f))) return false;
  const verb = /\b(create|write|implement|add|build|start|finish)\b/i;
  return verb.test(a) && verb.test(b);
}

function pushUnique(list: string[], item: string, max: number): string[] {
  const clean = oneLine(item);
  if (!clean) return list;
  if (list.some(existing => stepsTooSimilar(existing, clean))) return list;
  return [...list, clean].slice(-max);
}

export function renderWorkLog(log: WorkLog): string {
  const done = log.done.length ? log.done.map(step => `- ${step}`).join('\n') : '- (none yet)';
  const asked = log.asked.length ? log.asked.map(step => `- ${step}`).join('\n') : '- (none)';
  return [
    '# Work log',
    '',
    'Request:',
    log.request.trim() || '(none yet)',
    '',
    '## Done',
    done,
    '',
    '## Next',
    log.next.trim() || '(none)',
    '',
    '## Already asked',
    asked,
    ''
  ].join('\n');
}

function section(md: string, name: string, until?: string): string {
  const start = new RegExp(`## ${name}\\s*\\n`, 'i');
  const match = start.exec(md);
  if (!match) return '';
  const from = match.index + match[0].length;
  if (!until) return md.slice(from).trim();
  const end = new RegExp(`\\n## ${until}\\b`, 'i').exec(md.slice(from));
  return (end ? md.slice(from, from + end.index) : md.slice(from)).trim();
}

function bullets(block: string): string[] {
  return block
    .split('\n')
    .map(line => line.replace(/^- /, '').trim())
    .filter(line => line && line !== '(none)' && line !== '(none yet)');
}

export function parseWorkLog(md: string): WorkLog {
  const text = md || '';
  const requestMatch = /Request:\s*\n([\s\S]*?)\n## Done/i.exec(text);
  const next = section(text, 'Next', 'Already asked');
  return {
    request: (requestMatch?.[1] || '').trim(),
    done: bullets(section(text, 'Done', 'Next')).slice(-MAX_DONE),
    next: !next || next === '(none)' ? '' : oneLine(next, 400),
    asked: bullets(section(text, 'Already asked')).slice(-MAX_ASKED)
  };
}

export function hasWorkLog(log: WorkLog): boolean {
  return !!(log.request || log.next || log.done.length || log.asked.length);
}

/** First real user request seeds the log. Later turns update Next unless they are auto-continues. */
export function noteUserTurn(log: WorkLog, text: string): WorkLog {
  const line = text.replace(/\s+/g, ' ').trim();
  if (!line) return log;
  const request = log.request || line.slice(0, 800);
  if (/^continue:/i.test(line)) return { ...log, request };
  return { ...log, request, next: oneLine(line, 240) };
}

export function noteSavedFiles(
  log: WorkLog,
  tools: { name: string; status?: string; args?: { path?: string } }[]
): WorkLog {
  let done = log.done;
  for (const tool of tools) {
    if (tool.status !== 'done') continue;
    const path = tool.args?.path;
    if (!path) continue;
    if (tool.name === 'write_file') done = pushUnique(done, `Wrote ${path}`, MAX_DONE);
    else if (tool.name === 'edit_file') done = pushUnique(done, `Edited ${path}`, MAX_DONE);
  }
  let next = log.next;
  if (next && repeatsFinishedFile(done, next)) {
    done = pushUnique(done, next, MAX_DONE);
    next = '';
  }
  return { ...log, done, next };
}

export function advanceNext(log: WorkLog, task: string): WorkLog {
  const next = oneLine(task, 240);
  if (!next) return log;
  let done = log.done;
  if (log.next && !stepsTooSimilar(log.next, next)) done = pushUnique(done, log.next, MAX_DONE);
  return { ...log, done, next, asked: pushUnique(log.asked, next, MAX_ASKED) };
}

export function rememberAsked(log: WorkLog, text: string): WorkLog {
  return { ...log, asked: pushUnique(log.asked, text, MAX_ASKED) };
}

export function repeatsFinishedFile(done: string[], text: string): boolean {
  const files = fileNames(text);
  if (!files.length) return false;
  if (!/\b(create|write|implement|add|build|start)\b/i.test(text)) return false;
  return files.every(file =>
    done.some(step => step.toLowerCase().includes(file) && /\b(wrote|edited|saved|created|implemented)\b/i.test(step))
  );
}

export function timesAsked(log: WorkLog, text: string): number {
  return log.asked.filter(step => stepsTooSimilar(step, text)).length;
}

function alreadySatisfied(log: WorkLog, text: string): boolean {
  return log.done.some(step => stepsTooSimilar(step, text)) || repeatsFinishedFile(log.done, text);
}

/**
 * The Conductor must not continue or ask a step it already asked or already finished.
 * If the log has a different next step that has not been asked, run that instead.
 */
export function avoidRepeat(
  log: WorkLog,
  decision: 'continue' | 'ask' | 'done',
  task: string,
  options: PlanOption[]
): { decision: 'continue' | 'ask' | 'done'; task: string; options: PlanOption[]; note?: string } {
  if (decision === 'continue' && task && (timesAsked(log, task) >= 1 || alreadySatisfied(log, task))) {
    const logged = log.next.trim();
    if (
      logged &&
      !stepsTooSimilar(logged, task) &&
      timesAsked(log, logged) === 0 &&
      !alreadySatisfied(log, logged)
    ) {
      return { decision: 'continue', task: logged, options: [] };
    }
    return {
      decision: 'done',
      task: '',
      options: [],
      note: `Stopped repeating “${oneLine(task, 140)}”. Next in the work log: ${logged || 'nothing queued'}.`
    };
  }
  if (decision === 'ask') {
    if (!options.length) return { decision, task, options };
    const fresh = options.filter(option => {
      const label = `${option.title} ${option.description}`;
      return (
        timesAsked(log, option.title) === 0 &&
        timesAsked(log, label) === 0 &&
        !alreadySatisfied(log, label) &&
        !alreadySatisfied(log, option.title)
      );
    });
    if (!fresh.length) {
      return {
        decision: 'done',
        task: '',
        options: [],
        note: `Not asking that again. Next in the work log: ${log.next.trim() || 'nothing queued'}.`
      };
    }
    return { decision: 'ask', task, options: fresh };
  }
  return { decision, task, options };
}
