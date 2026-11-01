/** none → biggest local model, then free tier, then a confirmed paid call (or user ask). */
export type StuckStage = 'none' | 'big' | 'free' | 'paid';

const NOISE =
  /\b(read|verify|examine|check|look(?:\s+at)?|inspect|review|analyze|understand|investigate|the|a|an|to|for|and|of|in|on|with|please|ensure|correctly|handles?|functionality|logic|implementation|current|specific|issues?|keep|fixing|going)\b/gi;

/** Strip repeated "Keep fixing." / "Keep going." prefixes from work-log / stuck text. */
export function stripKeepFixingPrefix(text: string): string {
  let t = (text || '').replace(/\s+/g, ' ').trim();
  for (let i = 0; i < 16; i++) {
    const next = t.replace(/^(keep\s+fixing\.?\s*|keep\s+going\.?\s*)+/i, '').trim();
    if (next === t) break;
    t = next;
  }
  return t;
}

/**
 * Collapse verify/read wording so "Read app.js for hard drop" and
 * "Verify the hard drop logic in src/app.js" share one stuck key.
 */
export function stuckKey(task: string): string {
  const cleaned = stripKeepFixingPrefix(task);
  const files = [...cleaned.matchAll(/[A-Za-z0-9_.-]+\.(?:py|ts|tsx|js|jsx|json|md|html|css|go|rs|cpp|h|hpp|c|cs)/gi)].map(
    m => m[0].toLowerCase()
  );
  const body = cleaned
    .toLowerCase()
    .replace(NOISE, ' ')
    .replace(/[^a-z0-9.\s_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const uniqFiles = [...new Set(files)].sort().join(' ');
  const key = [uniqFiles, body].filter(Boolean).join(' ').trim();
  return (key || cleaned.toLowerCase().replace(/\s+/g, ' ').trim()).slice(0, 180);
}

export function nextStuckStage(stage: StuckStage): 'big' | 'free' | 'paid' {
  if (stage === 'none') return 'big';
  if (stage === 'big') return 'free';
  return 'paid';
}

/** When the stuck key changes, restart the ladder from none. */
export function resolveStuckStage(
  prev: { key: string; stage: StuckStage },
  key: string
): StuckStage {
  if (!key) return 'none';
  if (prev.key && prev.key !== key) return 'none';
  return prev.stage;
}

export function isRepeatStop(note?: string): boolean {
  if (!note) return false;
  return note.startsWith('Stopped repeating') || note.startsWith('Not asking that again');
}
