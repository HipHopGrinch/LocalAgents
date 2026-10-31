import { PlanOption } from '../types';

/** Steps already taken, the one next step, and questions already asked. */
export interface WorkLog {
  request: string;
  /** Sticky user bug report until a related file is written/edited. */
  bug: string;
  done: string[];
  next: string;
  asked: string[];
}

const MAX_DONE = 40;
const MAX_ASKED = 24;

const INSPECTION_ONLY =
  /^\s*(read|verify|examine|check|look(?:\s+at)?|inspect|review|analyze|understand|investigate)\b/i;
const FIX_VERB =
  /\b(fix|patch|edit|write|implement|add|build|create|correct|repair|wire|connect|update|change|remove|delete|save)\b/i;
const BUG_REPORT =
  /\b(fix|broken|doesn't work|does not work|not work|bug|error|failing|fails|wrong|missing|can't|cannot|spacebar|hard\s*drop|toggle)\b/i;
const VAGUE_USER =
  /^(option\s*\d+|keep going|continue|review(?:\s+the)?(?:\s+code)?|check(?:\s+it)?|look(?:\s+at\s+it)?)\b/i;

export function emptyWorkLog(): WorkLog {
  return { request: '', bug: '', done: [], next: '', asked: [] };
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

/** Inspection / verify / read-only wording — not a durable Next or Done. */
export function isInspectionOnly(text: string): boolean {
  const line = oneLine(text, 500);
  if (!line) return false;
  if (!INSPECTION_ONLY.test(line)) return false;
  // "Review X and fix the hard drop in app.js" still counts as durable.
  return !FIX_VERB.test(line);
}

/** A step that changes the workspace or runs a real command. */
export function isDurableStep(text: string): boolean {
  const line = oneLine(text, 500);
  if (!line) return false;
  if (isInspectionOnly(line)) return false;
  if (/^wrote\s+\S+/i.test(line) || /^edited\s+\S+/i.test(line)) return true;
  if (FIX_VERB.test(line) && (fileNames(line).length > 0 || BUG_REPORT.test(line))) return true;
  if (/\b(run|ran|command|test|build|compile|tsc|npm)\b/i.test(line)) return true;
  if (BUG_REPORT.test(line) && FIX_VERB.test(line)) return true;
  return false;
}

export function isBugReport(text: string): boolean {
  const line = oneLine(text, 500);
  if (!line || VAGUE_USER.test(line)) return false;
  return BUG_REPORT.test(line);
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
  const verb = /\b(create|write|implement|add|build|start|finish|fix|edit|patch)\b/i;
  return verb.test(a) && verb.test(b);
}

function pushUnique(list: string[], item: string, max: number): string[] {
  const clean = oneLine(item);
  if (!clean) return list;
  if (isInspectionOnly(clean)) return list;
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
    '## Bug',
    log.bug.trim() || '(none)',
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
  const requestMatch = /Request:\s*\n([\s\S]*?)\n## (?:Bug|Done)/i.exec(text);
  const bugSection = section(text, 'Bug', 'Done');
  const next = section(text, 'Next', 'Already asked');
  const bug =
    bugSection && bugSection !== '(none)'
      ? oneLine(bugSection, 400)
      : '';
  return {
    request: (requestMatch?.[1] || '').trim(),
    bug,
    done: bullets(section(text, 'Done', 'Next'))
      .filter(step => !isInspectionOnly(step))
      .slice(-MAX_DONE),
    next: (() => {
      if (!next || next === '(none)') return '';
      const line = oneLine(next, 400);
      return isDurableStep(line) ? line : '';
    })(),
    asked: bullets(section(text, 'Already asked')).slice(-MAX_ASKED)
  };
}

export function hasWorkLog(log: WorkLog): boolean {
  return !!(log.request || log.bug || log.next || log.done.length || log.asked.length);
}

/** First real user request seeds the log. Bug reports stick until a related file is saved. */
export function noteUserTurn(log: WorkLog, text: string): WorkLog {
  const line = text.replace(/\s+/g, ' ').trim();
  if (!line) return log;
  const request = log.request || line.slice(0, 800);
  if (/^continue:/i.test(line)) return { ...log, request };

  if (VAGUE_USER.test(line) || /^option\s*\d+/i.test(line)) {
    return {
      ...log,
      request,
      asked: pushUnique(log.asked, line, MAX_ASKED)
    };
  }

  if (isBugReport(line)) {
    return {
      ...log,
      request,
      bug: oneLine(line, 400),
      next: oneLine(line, 240)
    };
  }

  // Do not replace a sticky bug Next with polish / vague review wording.
  if (log.bug && !isDurableStep(line) && !isBugReport(line)) {
    return { ...log, request, asked: pushUnique(log.asked, line, MAX_ASKED) };
  }

  return { ...log, request, next: oneLine(line, 240) };
}

export function noteSavedFiles(
  log: WorkLog,
  tools: { name: string; status?: string; args?: { path?: string } }[]
): WorkLog {
  let done = log.done;
  const savedPaths: string[] = [];
  for (const tool of tools) {
    if (tool.status !== 'done') continue;
    const path = tool.args?.path;
    if (!path) continue;
    if (tool.name === 'write_file') {
      done = pushUnique(done, `Wrote ${path}`, MAX_DONE);
      savedPaths.push(path);
    } else if (tool.name === 'edit_file') {
      done = pushUnique(done, `Edited ${path}`, MAX_DONE);
      savedPaths.push(path);
    }
  }
  let next = log.next;
  let bug = log.bug;
  if (next && repeatsFinishedFile(done, next)) {
    if (isDurableStep(next)) done = pushUnique(done, next, MAX_DONE);
    next = bug && !bugClearedByPaths(bug, savedPaths) ? oneLine(bug, 240) : '';
  }
  if (bug && bugClearedByPaths(bug, savedPaths)) {
    bug = '';
    if (next && stepsTooSimilar(next, log.bug)) next = '';
  }
  return { ...log, done, next, bug };
}

function bugClearedByPaths(bug: string, paths: string[]): boolean {
  if (!paths.length) return false;
  const bugFiles = fileNames(bug);
  const saved = paths.map(p => p.replace(/\\/g, '/').toLowerCase());
  if (bugFiles.length) {
    return bugFiles.some(f => saved.some(p => p === f || p.endsWith('/' + f) || p.endsWith('\\' + f)));
  }
  // Bug named no file — any successful edit/write counts as progress on it.
  return paths.length > 0;
}

/**
 * Set Next only for durable work. Inspection tasks are ignored.
 * Old Next moves to Done only when it was durable.
 */
export function advanceNext(log: WorkLog, task: string): WorkLog {
  const next = oneLine(task, 240);
  if (!next) return log;
  if (!isDurableStep(next)) {
    return { ...log, asked: pushUnique(log.asked, next, MAX_ASKED) };
  }
  let done = log.done;
  if (log.next && !stepsTooSimilar(log.next, next) && isDurableStep(log.next)) {
    done = pushUnique(done, log.next, MAX_DONE);
  }
  // Sticky bug stays Next until files land, unless the new task is clearly that fix.
  if (log.bug && !stepsTooSimilar(next, log.bug) && !FIX_VERB.test(next)) {
    return { ...log, done, asked: pushUnique(log.asked, next, MAX_ASKED) };
  }
  return { ...log, done, next, asked: pushUnique(log.asked, next, MAX_ASKED) };
}

export function rememberAsked(log: WorkLog, text: string): WorkLog {
  return { ...log, asked: pushUnique(log.asked, text, MAX_ASKED) };
}

export function repeatsFinishedFile(done: string[], text: string): boolean {
  const files = fileNames(text);
  if (!files.length) return false;
  if (!/\b(create|write|implement|add|build|start|fix|edit|patch)\b/i.test(text)) return false;
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
    const logged = (log.bug || log.next).trim();
    if (
      logged &&
      !stepsTooSimilar(logged, task) &&
      timesAsked(log, logged) === 0 &&
      !alreadySatisfied(log, logged) &&
      isDurableStep(logged)
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
        note: `Not asking that again. Next in the work log: ${log.next.trim() || log.bug || 'nothing queued'}.`
      };
    }
    return { decision: 'ask', task, options: fresh };
  }
  return { decision, task, options };
}
