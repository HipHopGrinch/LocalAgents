import { ChatEvent, PullEvent } from '../types';
import { detectRepeatedToolTagSpam } from './agentLoop';

type ChatHandler = (e: ChatEvent) => void;
type PullHandler = (e: PullEvent) => void;

const chatHandlers = new Map<string, ChatHandler>();
const pullHandlers = new Map<string, PullHandler>();
let subscribed = false;

function ensureSubscribed() {
  if (subscribed || !window.electronAPI) return;
  subscribed = true;
  window.electronAPI.onChatEvent(e => chatHandlers.get(e.requestId)?.(e));
  window.electronAPI.onPullEvent(e => pullHandlers.get(e.requestId)?.(e));
}

const newId = (p: string) => `${p}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

export interface ChatResult {
  content: string;
  thinking: string;
  aborted: boolean;
  stats: ChatEvent['stats'];
  /** Stream stopped because the model repeated the same tool tag. */
  toolSpamAborted?: boolean;
}

export interface ChatHandle {
  requestId: string;
  done: Promise<ChatResult>;
  abort: () => void;
}

/** Stream chat completions through the main process (Ollama or OpenAI-compatible Frontier like Grok). */
export function streamChat(
  url: string,
  body: Record<string, unknown>,
  onDelta: (content: string, thinking: string) => void,
  nodeType?: 'ollama' | 'openai',
  apiKey?: string
): ChatHandle {
  ensureSubscribed();
  const requestId = newId('chat');
  let content = '';
  let thinking = '';
  let frame = 0;
  let spamAborted = false;
  let settled = false;

  const done = new Promise<ChatResult>((resolve, reject) => {
    const settle = (result: ChatResult) => {
      if (settled) return;
      settled = true;
      chatHandlers.delete(requestId);
      resolve(result);
    };
    chatHandlers.set(requestId, e => {
      if (e.type === 'chunk') {
        if (spamAborted || settled) return;
        content += e.content || '';
        thinking += e.thinking || '';
        // Local models sometimes collapse into repeating the same <read_file/> — cut it off.
        if (detectRepeatedToolTagSpam(content)) {
          spamAborted = true;
          if (frame) cancelAnimationFrame(frame);
          frame = 0;
          onDelta(content, thinking);
          window.electronAPI.abortStream(requestId);
          settle({ content, thinking, aborted: true, toolSpamAborted: true, stats: {} });
          return;
        }
        // Coalesce UI updates to one per animation frame - streaming 100+ tok/s would otherwise re-render per token
        if (!frame) {
          frame = requestAnimationFrame(() => {
            frame = 0;
            onDelta(content, thinking);
          });
        }
      } else {
        if (spamAborted || settled) return;
        if (frame) cancelAnimationFrame(frame);
        onDelta(content, thinking);
        if (e.type === 'done') settle({ content, thinking, aborted: false, stats: e.stats });
        else if (e.type === 'aborted') settle({ content, thinking, aborted: true, stats: {} });
        else {
          settled = true;
          chatHandlers.delete(requestId);
          reject(new Error(e.error || 'Unknown error'));
        }
      }
    });
  });

  window.electronAPI.chat(requestId, url, body, nodeType, apiKey).catch(err => {
    chatHandlers.get(requestId)?.({ requestId, type: 'error', error: String(err) });
  });

  return { requestId, done, abort: () => window.electronAPI.abortStream(requestId) };
}

export interface PullHandle {
  requestId: string;
  done: Promise<void>;
  abort: () => void;
}

export function pullModel(url: string, model: string, onProgress: (status: string, completed?: number, total?: number) => void): PullHandle {
  ensureSubscribed();
  const requestId = newId('pull');
  const done = new Promise<void>((resolve, reject) => {
    pullHandlers.set(requestId, e => {
      if (e.type === 'progress') onProgress(e.status || '', e.completed, e.total);
      else {
        pullHandlers.delete(requestId);
        if (e.type === 'done') resolve();
        else if (e.type === 'aborted') reject(new Error('Cancelled'));
        else reject(new Error(e.error || 'Pull failed'));
      }
    });
  });
  window.electronAPI.pullModel(requestId, url, model);
  return { requestId, done, abort: () => window.electronAPI.abortStream(requestId) };
}
