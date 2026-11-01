import { HardwareProfile, EndpointNode, OllamaModel } from '../types';
import { CatalogModel, MODEL_CATALOG, TASKS, TaskId } from '../config/modelCatalog';
import { resolveModelMaxContext } from './contextSize';

export type FitKind = 'gpu' | 'partial' | 'cpu' | 'none';

export interface FitEstimate {
  kind: FitKind;
  totalGB: number; // weights + KV cache + runtime overhead
  weightsGB: number;
  kvGB: number;
  gpuFraction: number; // share of the model resident in VRAM
  tokensPerSec: number; // rough generation-speed estimate
}

export interface Recommendation {
  model: CatalogModel;
  nodeId: string;
  task: TaskId;
  fit: FitEstimate;
  score: number;
  installed: boolean;
}

const KV_MULT = { f16: 1, q8_0: 0.53, q4_0: 0.28 } as const;

/** Conservative KV size when the architecture isn't in the catalog (overestimates rather than under). */
function kvKBPerToken(m: Pick<CatalogModel, 'kvKB' | 'paramsB' | 'activeB'>): number {
  if (m.kvKB !== undefined) return m.kvKB;
  return 6 * Math.pow(m.paramsB, 0.9);
}

/**
 * Estimate whether/how a model runs on a node.
 *
 * Token generation is memory-bandwidth bound: every generated token streams the active weights once.
 *   time/token ~ activeGB_on_gpu / gpuBW + activeGB_in_ram / ramBW
 * The efficiency factor accounts for real-world overhead (kernels, sampling, KV reads).
 */
export function estimateFit(
  m: Pick<CatalogModel, 'sizeGB' | 'paramsB' | 'activeB' | 'kvKB' | 'contextMax'>,
  hw: HardwareProfile,
  ctx: number
): FitEstimate {
  const effectiveCtx = Math.min(ctx, m.contextMax || ctx);
  const weightsGB = m.sizeGB;
  const kvGB = (kvKBPerToken(m) * effectiveCtx * KV_MULT[hw.kvCacheType || 'f16']) / (1024 * 1024);
  const overheadGB = 0.4 + weightsGB * 0.03;
  const totalGB = weightsGB + kvGB + overheadGB;

  const hasGpu = !!hw.gpu && hw.vramGB > 0;
  const usableVram = hasGpu ? Math.max(0, hw.vramGB - hw.reserveVramGB) : 0;
  const usableRam = Math.max(0, hw.ramGB * 0.75 - 4); // leave room for the OS and apps

  let kind: FitKind;
  let gpuFraction = 0;
  if (hasGpu && totalGB <= usableVram) {
    kind = 'gpu';
    gpuFraction = 1;
  } else if (hasGpu && totalGB <= usableVram + usableRam) {
    kind = 'partial';
    gpuFraction = Math.max(0, Math.min(1, usableVram / totalGB));
  } else if (totalGB <= usableRam + usableVram) {
    kind = 'cpu';
  } else {
    kind = 'none';
  }

  const activeGB = weightsGB * ((m.activeB ?? m.paramsB) / m.paramsB);
  let tokensPerSec = 0;
  if (kind !== 'none') {
    const gpuBW = hw.gpuBandwidthGBs || 1;
    const ramBW = hw.ramBandwidthGBs || 40;
    const seconds = (activeGB * gpuFraction) / gpuBW + (activeGB * (1 - gpuFraction)) / ramBW;
    const efficiency = kind === 'gpu' ? 0.65 : kind === 'partial' ? 0.45 : 0.55;
    tokensPerSec = seconds > 0 ? efficiency / seconds : 0;
  }

  return { kind, totalGB, weightsGB, kvGB, gpuFraction, tokensPerSec: Math.round(tokensPerSec) };
}

const FIT_FACTOR: Record<FitKind, number> = { gpu: 1, partial: 0.9, cpu: 0.75, none: 0 };

export function scoreFor(model: CatalogModel, task: TaskId, fit: FitEstimate, ctx: number): number {
  const quality = model.quality[task];
  if (!quality || fit.kind === 'none') return 0;
  const minTps = TASKS.find(t => t.id === task)?.minTps ?? 0;
  const speedFactor = minTps > 0 ? Math.min(1, Math.sqrt(fit.tokensPerSec / minTps)) : 1;
  const ctxFactor = model.contextMax >= ctx ? 1 : 0.85;
  return quality * FIT_FACTOR[fit.kind] * speedFactor * ctxFactor;
}

/** Normalize tags so "foo" matches "foo:latest" */
export const normTag = (t: string) => (t.includes(':') ? t : `${t}:latest`).toLowerCase();

export function isInstalled(node: EndpointNode, tag: string): boolean {
  const want = normTag(tag);
  return node.models.some(m => normTag(m.name) === want);
}

/** Ranked recommendations for one node and task. */
export function recommend(node: EndpointNode, task: TaskId, ctx: number, limit = 5): Recommendation[] {
  return MODEL_CATALOG.filter(m => m.quality[task])
    .map(model => {
      const taskCtx = task === 'embedding' ? Math.min(ctx, model.contextMax) : ctx;
      const fit = estimateFit(model, node.hardware, taskCtx);
      return { model, nodeId: node.id, task, fit, score: scoreFor(model, task, fit, ctx), installed: isInstalled(node, model.tag) };
    })
    .filter(r => r.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

/** Parse "14b" / "7.6B" / "e4b" style parameter hints from a tag or Ollama details. */
export function parseParams(text: string | undefined): number | undefined {
  if (!text) return undefined;
  const m = text.toLowerCase().match(/(\d+(?:\.\d+)?)\s*([bm])\b/);
  if (!m) return undefined;
  return m[2] === 'm' ? parseFloat(m[1]) / 1000 : parseFloat(m[1]);
}

export function formatGB(gb: number): string {
  return gb >= 10 ? `${gb.toFixed(0)} GB` : `${gb.toFixed(1)} GB`;
}

export const FIT_LABEL: Record<FitKind, string> = {
  gpu: 'Full GPU',
  partial: 'GPU + RAM',
  cpu: 'CPU only',
  none: "Won't fit"
};

/** Match an installed Ollama tag to a catalog row (exact tag, then family prefix). */
export function findCatalogModel(modelName: string): CatalogModel | undefined {
  const want = normTag(modelName);
  const exact = MODEL_CATALOG.find(m => normTag(m.tag) === want);
  if (exact) return exact;
  const lower = modelName.toLowerCase();
  return MODEL_CATALOG.find(m => {
    const tag = m.tag.toLowerCase();
    const base = tag.split(':')[0];
    const nameBase = lower.split(':')[0];
    return lower.startsWith(base + ':') || tag.startsWith(nameBase + ':') || lower === base;
  });
}

/**
 * VRAM estimate for an installed Ollama model at a chosen num_ctx.
 * Uses on-disk size as weightsGB; catalog/heuristics for KV params.
 */
export function estimateInstalledModelFit(
  model: Pick<OllamaModel, 'name' | 'size' | 'details'>,
  hw: HardwareProfile,
  ctx: number
): FitEstimate {
  const catalog = findCatalogModel(model.name);
  const sizeGB =
    model.size > 0 ? model.size / 1e9 : catalog?.sizeGB ?? 4;
  const paramsB =
    catalog?.paramsB ??
    parseParams(model.details?.parameter_size) ??
    parseParams(model.name) ??
    7;
  const contextMax =
    resolveModelMaxContext(model.name, model) ??
    catalog?.contextMax ??
    Math.max(ctx, 8192);
  const pick: Pick<CatalogModel, 'sizeGB' | 'paramsB' | 'activeB' | 'kvKB' | 'contextMax'> = {
    sizeGB,
    paramsB,
    contextMax,
    ...(catalog?.activeB != null ? { activeB: catalog.activeB } : {}),
    ...(catalog?.kvKB != null ? { kvKB: catalog.kvKB } : {})
  };
  return estimateFit(pick, hw, ctx);
}

/** True when the estimate does not fit fully in usable GPU VRAM. */
export function fitSpillsToSystemRam(kind: FitKind): boolean {
  return kind === 'partial' || kind === 'cpu' || kind === 'none';
}
