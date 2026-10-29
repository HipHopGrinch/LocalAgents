import { ModelThinkingInfo, OllamaModel } from '../types';

/** Normalize /api/show thinking metadata into a stable shape. */
export function normalizeThinkingInfo(
  thinking: unknown,
  capabilities?: string[]
): ModelThinkingInfo | undefined {
  if (thinking && typeof thinking === 'object') {
    const t = thinking as { values?: unknown; default?: unknown };
    if (Array.isArray(t.values) && t.values.length > 0) {
      return {
        values: t.values as Array<boolean | string>,
        default: t.default as boolean | string | undefined
      };
    }
  }
  if (capabilities?.includes('thinking')) {
    return { values: [false, true], default: true };
  }
  return undefined;
}

/**
 * True when Ollama advertises controllable thinking.
 * `values: [false]` alone means the model does not support thinking.
 */
export function modelSupportsThinking(model?: Pick<OllamaModel, 'name' | 'capabilities' | 'thinking'>): boolean {
  if (!model) return false;
  const vals = model.thinking?.values;
  if (vals && vals.length > 0) {
    if (vals.length === 1 && vals[0] === false) return false;
    return vals.some(v => v === true || (typeof v === 'string' && v.length > 0));
  }
  if (model.capabilities?.includes('thinking')) return true;
  return false;
}

/** Effective think flag for a chat request (undefined = omit / model default). */
export function resolveThinkOption(
  model: Pick<OllamaModel, 'name' | 'thinking' | 'capabilities'> | undefined,
  userPref: boolean | string | null | undefined
): boolean | string | undefined {
  if (!modelSupportsThinking(model)) return undefined;
  if (userPref === null || userPref === undefined) {
    // Prefer off for IDE latency when first using a thinking model with no saved pref
    return false;
  }
  return userPref;
}

export function thinkingToggleLabel(enabled: boolean): string {
  return enabled ? 'Thinking ON' : 'Thinking OFF';
}
