import { ChatConversation, ChatMessage } from '../types';

export const MAX_STORED_CONVERSATIONS = 40;
export const MAX_RECENT_WORKSPACES = 12;

export function normalizeWorkspacePath(p: string): string {
  return (p || '').replace(/[\\/]+$/, '').replace(/\\/g, '/').toLowerCase();
}

export function workspaceLabel(p: string): string {
  const trimmed = (p || '').replace(/[\\/]+$/, '');
  const parts = trimmed.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] || trimmed || 'No folder';
}

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
  const root = normalizeWorkspacePath(workspacePath);
  return (all || [])
    .filter(c => normalizeWorkspacePath(c.workspacePath || '') === root)
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

/** Upsert one conversation and keep the newest chats per project. */
export function upsertConversation(
  all: ChatConversation[] | undefined,
  next: ChatConversation
): ChatConversation[] {
  const list = [...(all || [])];
  const idx = list.findIndex(c => c.id === next.id);
  if (idx >= 0) list[idx] = next;
  else list.unshift(next);

  const groups = new Map<string, ChatConversation[]>();
  for (const c of list) {
    const key = normalizeWorkspacePath(c.workspacePath || '');
    const group = groups.get(key) || [];
    group.push(c);
    groups.set(key, group);
  }
  const out: ChatConversation[] = [];
  for (const group of groups.values()) {
    group.sort((a, b) => b.updatedAt - a.updatedAt);
    out.push(...group.slice(0, MAX_STORED_CONVERSATIONS));
  }
  return out.sort((a, b) => b.updatedAt - a.updatedAt);
}

export function replaceWorkspaceConversations(
  all: ChatConversation[] | undefined,
  workspacePath: string,
  nextForWorkspace: ChatConversation[]
): ChatConversation[] {
  const root = normalizeWorkspacePath(workspacePath);
  const others = (all || []).filter(c => normalizeWorkspacePath(c.workspacePath || '') !== root);
  const kept = [...nextForWorkspace]
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, MAX_STORED_CONVERSATIONS);
  return [...kept, ...others];
}

export function rememberWorkspace(recent: string[] | undefined, workspacePath: string): string[] {
  const path = workspacePath.replace(/[\\/]+$/, '');
  if (!path) return recent || [];
  const key = normalizeWorkspacePath(path);
  const rest = (recent || []).filter(p => normalizeWorkspacePath(p) !== key);
  return [path, ...rest].slice(0, MAX_RECENT_WORKSPACES);
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
