import { ChatConversation, ChatMessage } from '../types';

export const MAX_STORED_CONVERSATIONS = 40;

export function newConversationId(): string {
  return `chat-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

export function createConversation(
  workspacePath: string,
  agentId: string,
  messages: ChatMessage[] = []
): ChatConversation {
  const now = Date.now();
  return {
    id: newConversationId(),
    title: 'New chat',
    workspacePath: workspacePath || '',
    agentId,
    messages,
    createdAt: now,
    updatedAt: now
  };
}

/** Derive a short title from the first user message (Cursor-style). */
export function titleFromMessages(messages: ChatMessage[]): string {
  const firstUser = messages.find(m => m.role === 'user' && m.display.trim());
  if (!firstUser) return 'New chat';
  const text = firstUser.display.replace(/\s+/g, ' ').trim();
  return text.length > 48 ? `${text.slice(0, 45)}…` : text;
}

export function conversationsForWorkspace(
  all: ChatConversation[] | undefined,
  workspacePath: string
): ChatConversation[] {
  const root = (workspacePath || '').toLowerCase();
  return (all || [])
    .filter(c => (c.workspacePath || '').toLowerCase() === root)
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

/** Upsert one conversation and prune oldest beyond the cap. */
export function upsertConversation(
  all: ChatConversation[] | undefined,
  next: ChatConversation
): ChatConversation[] {
  const list = [...(all || [])];
  const idx = list.findIndex(c => c.id === next.id);
  if (idx >= 0) list[idx] = next;
  else list.unshift(next);
  return list
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, MAX_STORED_CONVERSATIONS);
}

export function formatConversationTime(ts: number): string {
  const d = new Date(ts);
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  if (sameDay) {
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }
  return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
}
