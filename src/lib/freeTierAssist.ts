import { EndpointNode } from '../types';
import { getEnabledModelsForNode, getPreferredModelForNode, isFrontierNode } from './tools';

/** Conservative Flash-class free quota. Raise it on the node when the key's daily limit is higher. */
export const DEFAULT_FREE_TIER_DAILY_CAP = 20;
/**
 * Default requests-per-minute for free Gemini/OpenRouter-style keys.
 * Studio paces assists and waits on 429 instead of failing immediately.
 */
export const DEFAULT_FREE_TIER_RPM = 10;
/** Output cap so a free-tier assist stays a brief, not a rewritten file. */
export const ASSIST_MAX_PREDICT = 480;
/** Stay under a 250K token free-tier minute. */
export const ASSIST_INPUT_CHARS = 180_000;
/** Max time to wait for an RPM slot (ms). */
export const FREE_TIER_RPM_WAIT_CAP_MS = 90_000;

export interface FreeTierUsage {
  day: string;
  count: number;
}

/** Rolling timestamps of free-tier assists per node (in-memory; not persisted). */
const freeTierRpmStamps = new Map<string, number[]>();

export const FREE_TIER_ASSIST_SYSTEM = `You assist a local coding model. Reply in at most 120 words.
Do not rewrite files. Do not add a preamble.
If this is a review, list each real bug as: file path, what is wrong, the small edit.
If this is a context brief, state the user request, what is already done, and the single next action.`;

export function freeTierDay(now = new Date()): string {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

export function freeTierCap(node: Pick<EndpointNode, 'freeTierDailyCap'>): number {
  const n = node.freeTierDailyCap;
  if (typeof n === 'number' && Number.isFinite(n) && n >= 1) return Math.min(500, Math.floor(n));
  return DEFAULT_FREE_TIER_DAILY_CAP;
}

export function freeTierRpm(node: Pick<EndpointNode, 'freeTierRpm'>): number {
  const n = node.freeTierRpm;
  if (typeof n === 'number' && Number.isFinite(n) && n >= 1) return Math.min(60, Math.floor(n));
  return DEFAULT_FREE_TIER_RPM;
}

function pruneRpmStamps(stamps: number[], now: number): number[] {
  const windowStart = now - 60_000;
  return stamps.filter(t => t > windowStart);
}

/** Ms until a free-tier request can start without exceeding the node's RPM. 0 = ready. */
export function freeTierRpmWaitMs(
  nodeId: string,
  rpm: number,
  now = Date.now()
): number {
  const limit = Math.max(1, Math.min(60, Math.floor(rpm) || DEFAULT_FREE_TIER_RPM));
  const stamps = pruneRpmStamps(freeTierRpmStamps.get(nodeId) || [], now);
  freeTierRpmStamps.set(nodeId, stamps);
  if (stamps.length < limit) return 0;
  const oldest = stamps[0];
  return Math.max(0, oldest + 60_000 - now + 50);
}

/** Record that a free-tier request is starting (call after waiting). */
export function noteFreeTierRpmRequest(nodeId: string, now = Date.now()): void {
  const stamps = pruneRpmStamps(freeTierRpmStamps.get(nodeId) || [], now);
  stamps.push(now);
  freeTierRpmStamps.set(nodeId, stamps);
}

/**
 * Wait until this node's free-tier RPM window has a free slot.
 * Returns ms waited (0 if immediate). Throws nothing — caps wait at FREE_TIER_RPM_WAIT_CAP_MS.
 */
export async function waitForFreeTierRpm(
  node: Pick<EndpointNode, 'id' | 'freeTierRpm'>,
  opts?: { signal?: { aborted?: boolean }; onWait?: (ms: number) => void }
): Promise<number> {
  const rpm = freeTierRpm(node);
  let waited = 0;
  for (;;) {
    if (opts?.signal?.aborted) return waited;
    const need = freeTierRpmWaitMs(node.id, rpm);
    if (need <= 0) {
      noteFreeTierRpmRequest(node.id);
      return waited;
    }
    if (waited + need > FREE_TIER_RPM_WAIT_CAP_MS) {
      // Still claim a slot after the cap so the call can proceed (API may 429; stream layer retries).
      noteFreeTierRpmRequest(node.id);
      return waited;
    }
    opts?.onWait?.(need);
    const slice = Math.min(need, 5_000);
    await new Promise<void>(resolve => setTimeout(resolve, slice));
    waited += slice;
  }
}

/** True when an API/stream error looks like a provider rate limit. */
export function isRateLimitError(message: string | undefined): boolean {
  const m = (message || '').toLowerCase();
  if (!m) return false;
  if (/\b429\b/.test(m)) return true;
  if (/rate[- ]?limit|quota|resource.?exhausted|too many requests|rpm\b|requests per minute/i.test(m)) {
    return true;
  }
  return false;
}

/** Parse Retry-After seconds from an error string, or default backoff. */
export function rateLimitBackoffMs(message: string | undefined, attempt = 0): number {
  const m = message || '';
  const header = m.match(/retry-after[=:\s]+(\d+)/i);
  if (header) return Math.min(120_000, Math.max(1_000, Number(header[1]) * 1000));
  const sec = m.match(/try again in\s+(\d+(?:\.\d+)?)\s*s/i);
  if (sec) return Math.min(120_000, Math.max(1_000, Math.ceil(Number(sec[1]) * 1000)));
  // 15s, 30s, 60s…
  return Math.min(90_000, 15_000 * Math.pow(2, Math.max(0, attempt)));
}

export function freeTierUsed(usage: FreeTierUsage | undefined, now = new Date()): number {
  if (!usage || usage.day !== freeTierDay(now)) return 0;
  return Math.max(0, usage.count || 0);
}

export function bumpFreeTierUsage(usage: FreeTierUsage | undefined, now = new Date()): FreeTierUsage {
  const day = freeTierDay(now);
  const count = usage && usage.day === day ? freeTierUsed(usage, now) + 1 : 1;
  return { day, count };
}

export function estimateTokens(text: string): number {
  return Math.ceil((text || '').length / 4);
}

/** The local model cannot hold this prompt. */
export function contextOverflow(tokens: number, numCtx: number): boolean {
  if (!numCtx || numCtx < 512) return false;
  return tokens > Math.floor(numCtx * 0.9);
}

/**
 * Several files whose text does not fit the local reviewer.
 * Two short files stay local so a free call is not spent.
 * One file asks for help only when it overflows the local window.
 */
export function reviewNeedsAssist(fileCount: number, chars: number, numCtx: number): boolean {
  const tokens = Math.ceil(Math.max(0, chars) / 4);
  const ctx = numCtx > 0 ? numCtx : 16384;
  if (fileCount >= 2) return tokens > Math.floor(ctx * 0.55);
  return tokens > Math.floor(ctx * 0.9);
}

export function tailForAssist(text: string): string {
  if (text.length <= ASSIST_INPUT_CHARS) return text;
  return text.slice(text.length - ASSIST_INPUT_CHARS);
}

export interface FreeTierTarget {
  node: EndpointNode;
  model: string;
  used: number;
  cap: number;
}

/** Online free-tier frontier node with quota left. Prefers the largest remaining daily budget. */
export function pickFreeTierAssist(
  nodes: EndpointNode[],
  usageFor?: (node: EndpointNode) => FreeTierUsage | undefined,
  now = new Date()
): FreeTierTarget | undefined {
  let best: FreeTierTarget | undefined;
  let bestRemaining = 0;
  for (const node of nodes) {
    if (!node.freeTier || !node.online || !isFrontierNode(node)) continue;
    const model = getPreferredModelForNode(node);
    if (!model || !getEnabledModelsForNode(node).includes(model)) continue;
    const cap = freeTierCap(node);
    const used = freeTierUsed(usageFor ? usageFor(node) : node.freeTierUsage, now);
    const remaining = cap - used;
    if (remaining <= 0) continue;
    if (!best || remaining > bestRemaining) {
      best = { node, model, used, cap };
      bestRemaining = remaining;
    }
  }
  return best;
}

/** A frontier node that is not marked free tier. */
export function pickPaidFrontier(nodes: EndpointNode[]): { node: EndpointNode; model: string } | undefined {
  for (const node of nodes) {
    if (!node.online || !isFrontierNode(node) || node.freeTier) continue;
    const model = getPreferredModelForNode(node);
    if (!model || !getEnabledModelsForNode(node).includes(model)) continue;
    return { node, model };
  }
  return undefined;
}
