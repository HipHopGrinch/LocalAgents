import React from 'react';
import type { ChatMessage } from '../../types';

const BLINK_DELAYS = ['0ms', '180ms', '360ms'];

function shortText(text: string, max = 48): string {
  const cleaned = text.replace(/\s+/g, ' ').trim();
  if (cleaned.length <= max) return cleaned;
  return `${cleaned.slice(0, max - 1).trimEnd()}…`;
}

/** First readable line, without a leading emoji or markdown fence. */
function displayTail(display: string): string {
  const lines = display
    .split('\n')
    .map(line => line.trim())
    .filter(line => line && !line.startsWith('```'));
  const last = lines[lines.length - 1] || '';
  const cleaned = last.replace(/^[^A-Za-z0-9]+/, '').replace(/`/g, '');
  return shortText(cleaned);
}

/**
 * Status next to the activity squares. Uses only the latest assistant message:
 * pipeline step status, or a short slice of display text already on screen.
 */
export function streamingActivityLabel(message: ChatMessage | undefined): string {
  if (!message) return 'Working';

  const steps = message.pipelineSteps;
  if (steps && steps.length > 0) {
    const running = steps.find(step => step.status === 'running');
    if (running) {
      const who = (running.targetFile || running.nodeName || '').trim();
      return who ? `Working · ${who}` : 'Working';
    }
    const pending = steps.filter(step => step.status === 'pending').length;
    if (pending > 0) {
      return `Queued · ${pending} file${pending === 1 ? '' : 's'}`;
    }
    const display = message.display || '';
    if (/\btsc\b/i.test(display)) return 'Checking types';
    return displayTail(display) || 'Working';
  }

  if (steps === undefined) return 'Generating';

  const display = (message.display || '').trim();
  const withoutMark = display.replace(/^[^A-Za-z0-9]+/, '');
  if (/^pass 1\b/i.test(withoutMark)) {
    const beforeDetail = withoutMark.split('(')[0].replace(/[—–-]\s*$/, '').trim();
    return shortText(beforeDetail || withoutMark);
  }
  return 'Working';
}

/** Three staggered squares plus a short status. Hidden by the parent when idle. */
export const ActivityIndicator: React.FC<{ label: string }> = ({ label }) => (
  <div className="flex items-center gap-2 min-w-0 mb-2 px-0.5" role="status" aria-live="polite">
    <span className="flex items-center gap-1 shrink-0" aria-hidden="true">
      {BLINK_DELAYS.map(delay => (
        <span
          key={delay}
          className="block h-1.5 w-1.5 rounded-[2px] bg-amber-400 animate-activity-square motion-reduce:animate-none"
          style={{ animationDelay: delay }}
        />
      ))}
    </span>
    <span className="truncate text-[11px] font-medium text-amber-200/90">{label}</span>
  </div>
);
