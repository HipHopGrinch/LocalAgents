import { EndpointNode, OllamaModel } from '../types';
import { MODEL_CATALOG } from '../config/modelCatalog';

/**
 * Rough English-text capacity estimates for a context window.
 *
 * Scheme (labeled as approximate in the UI HelpTip):
 * - 1 token ≈ 0.75 English words
 * - 1 page ≈ 500 words ≈ 667 tokens
 * - 1 short website ≈ 2,500 tokens
 * - 1 medium source file ≈ 1,500 tokens
 * - 1 chat turn (user+assistant) ≈ 400 tokens
 */
export const CTX_WORDS_PER_TOKEN = 0.75;
export const CTX_PAGE_TOKENS = 667;
export const CTX_SHORT_SITE_TOKENS = 2500;
export const CTX_MEDIUM_FILE_TOKENS = 1500;
export const CTX_CHAT_TURN_TOKENS = 400;

/** Common Ollama num_ctx presets shown in Hardware Settings. */
export const COMMON_CTX_SIZES = [2048, 4096, 8192, 16384, 32768, 65536, 131072] as const;

export const DEFAULT_MODEL_NUM_CTX = 16384;

export function formatCtxLabel(tokens: number): string {
  if (tokens >= 1024 && tokens % 1024 === 0) {
    const k = tokens / 1024;
    return k >= 1024 ? `${k / 1024}M` : `${k}k`;
  }
  if (tokens >= 1000) {
    const k = Math.round(tokens / 1000);
    return `~${k}k`;
  }
  return String(tokens);
}

export function estimateContextFit(tokens: number): {
  pages: number;
  shortSites: number;
  codeFiles: number;
  chatTurns: number;
  label: string;
} {
  const pages = Math.max(0, Math.round(tokens / CTX_PAGE_TOKENS));
  const shortSites = Math.max(0, Math.round((tokens / CTX_SHORT_SITE_TOKENS) * 10) / 10);
  const codeFiles = Math.max(0, Math.round((tokens / CTX_MEDIUM_FILE_TOKENS) * 10) / 10);
  const chatTurns = Math.max(0, Math.round(tokens / CTX_CHAT_TURN_TOKENS));
  const fmt = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(1));
  const label = `~${formatCtxLabel(tokens)} tokens · ~${pages} pages · ~${fmt(shortSites)} short sites · ~${fmt(codeFiles)} code files`;
  return { pages, shortSites, codeFiles, chatTurns, label };
}

/** Known max context for a model name (details → catalog → undefined). */
export function resolveModelMaxContext(
  modelName: string,
  model?: Pick<OllamaModel, 'details'> | null
): number | undefined {
  const fromDetails = model?.details?.context_length;
  if (typeof fromDetails === 'number' && fromDetails > 0) return fromDetails;

  const lower = modelName.toLowerCase();
  const catalog = MODEL_CATALOG.find(m => {
    const tag = m.tag.toLowerCase();
    return lower === tag || lower.startsWith(tag.split(':')[0] + ':') || tag.startsWith(lower.split(':')[0] + ':');
  });
  if (catalog?.contextMax) return catalog.contextMax;
  return undefined;
}

/** Sizes offered in the select, capped by known model max when available. */
export function ctxSizeOptions(maxCtx?: number, current?: number): number[] {
  let base: number[] = [...COMMON_CTX_SIZES];
  if (maxCtx && maxCtx > 0 && !base.includes(maxCtx)) {
    base.push(maxCtx);
  }
  // Keep a previously saved value visible in the list (no free-form number entry).
  if (typeof current === 'number' && current > 0 && !base.includes(current)) {
    base.push(Math.floor(current));
  }
  base.sort((a, b) => a - b);
  if (maxCtx && maxCtx > 0) base = base.filter(s => s <= maxCtx);
  // If current was above max, still offer the clamped presets only — caller snaps the value.
  return base.length ? base : [...COMMON_CTX_SIZES];
}

/** Nearest preset for a stored num_ctx so the UI never needs a free-form number field. */
export function snapNumCtxToOption(value: number, maxCtx?: number): number {
  const options = ctxSizeOptions(maxCtx);
  const n = clampNumCtx(value, maxCtx);
  if (options.includes(n)) return n;
  let best = options[0];
  let bestDist = Math.abs(best - n);
  for (const opt of options) {
    const d = Math.abs(opt - n);
    if (d < bestDist) {
      best = opt;
      bestDist = d;
    }
  }
  return best;
}

export function resolveModelNumCtx(
  node: Pick<EndpointNode, 'modelPrefs'> | undefined,
  model: string,
  fallback: number = DEFAULT_MODEL_NUM_CTX
): number {
  const pref = node?.modelPrefs?.[model]?.numCtx;
  if (typeof pref === 'number' && pref > 0) return Math.floor(pref);
  return fallback > 0 ? Math.floor(fallback) : DEFAULT_MODEL_NUM_CTX;
}

export function clampNumCtx(value: number, maxCtx?: number): number {
  let n = Math.floor(value);
  if (!Number.isFinite(n) || n < 512) n = 512;
  if (maxCtx && maxCtx > 0) n = Math.min(n, maxCtx);
  return n;
}
