/** none → biggest local model, then free tier, then a confirmed paid call. */
export type StuckStage = 'none' | 'big' | 'free' | 'paid';

export function stuckKey(task: string): string {
  return task.toLowerCase().replace(/\s+/g, ' ').trim().slice(0, 180);
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
