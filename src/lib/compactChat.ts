import { ChatMessage } from '../types';

/** Rough token count of the text that would be sent back to the model. */
export function historyTokens(messages: ChatMessage[]): number {
  return messages.reduce((sum, message) => sum + Math.ceil((message.raw || message.display || '').length / 4), 0);
}

export function shouldCompact(messages: ChatMessage[], numCtx: number): boolean {
  if (messages.length < 6) return false;
  const budget = Math.max(3000, Math.floor((numCtx || 16384) * 0.4));
  return historyTokens(messages) > budget;
}

function fileNotes(message: ChatMessage): string[] {
  const notes: string[] = [];
  const take = (name: string, path?: string, status?: string) => {
    if (name !== 'write_file' && name !== 'edit_file') return;
    if (!path) return;
    notes.push(`${status === 'done' ? (name === 'edit_file' ? 'Edited' : 'Wrote') : 'Proposed'} ${path}`);
  };
  for (const tool of message.toolCalls || []) take(tool.name, tool.args?.path, tool.status);
  for (const step of message.pipelineSteps || []) {
    for (const tool of step.toolCalls || []) take(tool.name, tool.args?.path || step.targetFile, tool.status);
  }
  return notes;
}

function shortenMessage(message: ChatMessage, keepImages: boolean): ChatMessage {
  const notes = fileNotes(message);
  const prose = (message.display || message.raw || '').replace(/\s+/g, ' ').trim().slice(0, 700);
  const text = [prose, notes.length ? notes.join(', ') : ''].filter(Boolean).join('\n').trim() || '(empty)';
  return {
    ...message,
    raw: text,
    display: (message.display || '').length <= 900 ? message.display || text : text,
    thinking: undefined,
    images: keepImages ? message.images : undefined,
    toolCalls: undefined,
    pipelineSteps: undefined
  };
}

/** Fold older turns into one short note. Recent turns stay, without full file bodies. */
export function compactMessages(messages: ChatMessage[]): ChatMessage[] {
  if (messages.length < 6) return messages;
  const recent = messages.slice(-4);
  const firstUser = messages.find(message => message.role === 'user');
  const dropped = messages.slice(0, messages.length - 4).filter(message => message.id !== firstUser?.id);
  const lines = [...new Set(dropped.flatMap(message => {
    const bits: string[] = [];
    if (message.role === 'user') {
      const asked = (message.display || message.raw || '').replace(/\s+/g, ' ').trim().slice(0, 180);
      if (asked) bits.push(`Asked: ${asked}`);
    }
    bits.push(...fileNotes(message));
    return bits;
  }))].slice(-30);

  const summary: ChatMessage = {
    id: `compact-${Date.now()}`,
    role: 'assistant',
    raw: [
      '[Compacted earlier chat]',
      `Folded ${dropped.length} messages. Finished steps and the next step are in the work log, which is still in context.`,
      lines.join('\n')
    ].filter(Boolean).join('\n'),
    display: `Compacted ${dropped.length} earlier messages. The work log still has the finished steps and the next step.`,
    timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
    notice: 'Compacted conversation'
  };

  const head =
    firstUser && !recent.some(message => message.id === firstUser.id)
      ? [shortenMessage(firstUser, false)]
      : [];
  const lastUserId = [...recent].reverse().find(message => message.role === 'user')?.id;
  return [...head, summary, ...recent.map(message => shortenMessage(message, message.id === lastUserId))];
}
