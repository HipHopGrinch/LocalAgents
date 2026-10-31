/** none → biggest local model, then free tier, then a confirmed paid call. */
export type StuckStage = 'none' | 'big' | 'free' | 'paid';

const NOISE =
  /\b(read|verify|examine|check|look(?:\s+at)?|inspect|review|analyze|understand|investigate|the|a|an|to|for|and|of|in|on|with|please|ensure|correctly|handles?|functionality|logic|implementation|current|specific|issues?)\b/gi;

/**
 * Collapse verify/read wording so "Read app.js for hard drop" and
 * "Verify the hard drop logic in src/app.js" share one stuck key.
 */
export function stuckKey(task: string): string {
  const files = [...task.matchAll(/[A-Za-z0-9_.-]+\.(?:py|ts|tsx|js|jsx|json|md|html|css|go|rs)/gi)].map(m =>
    m[0].toLowerCase()
  );
  const body = task
    .toLowerCase()
    .replace(NOISE, ' ')
    .replace(/[^a-z0-9.\s_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const uniqFiles = [...new Set(files)].sort().join(' ');
  const key = [uniqFiles, body].filter(Boolean).join(' ').trim();
  return (key || task.toLowerCase().replace(/\s+/g, ' ').trim()).slice(0, 180);
}

export function nextStuckStage(stage: StuckStage): 'big' | 'free' | 'paid' {
  if (stage === 'none') return 'big';
  if (stage === 'big') return 'free';
  return 'paid';
}

export function isRepeatStop(note?: string): boolean {
  if (!note) return false;
  return note.startsWith('Stopped repeating') || note.startsWith('Not asking that again');
}
