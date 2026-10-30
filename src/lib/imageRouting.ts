import { EndpointNode } from '../types';
import { isFrontierNode } from './tools';

const IMAGE_NAME =
  /flux|sdxl|stable[-_]?diffusion|kolors|qwen[-_]?image|dreamshaper|playground|auraflow|hidream|omnigen|kandinsky|z-image|image[-_]?gen|sd3|juggernaut/i;

export function modelLooksLikeImageGen(name: string, capabilities?: string[]): boolean {
  const caps = (capabilities || []).map(c => c.toLowerCase());
  if (caps.some(c => c.includes('image') && (c.includes('gen') || c.includes('diffusion') || c === 'image'))) {
    return true;
  }
  return IMAGE_NAME.test(name);
}

export interface ImageTarget {
  node: EndpointNode;
  model: string;
}

/** Online local node with an image-generation model. Frontier only if nothing local qualifies. */
export function pickImageTarget(nodes: EndpointNode[]): ImageTarget | null {
  const forced: ImageTarget[] = [];
  const hits: ImageTarget[] = [];
  for (const node of nodes) {
    if (!node.online) continue;
    const models = node.models || [];
    const disabled = new Set(node.disabledModels || []);
    if (node.imageModel && !disabled.has(node.imageModel) && models.some(m => m.name === node.imageModel)) {
      forced.push({ node, model: node.imageModel });
    }
    for (const model of models) {
      if (disabled.has(model.name)) continue;
      const caps = model.capabilities || node.modelMeta?.[model.name]?.capabilities;
      if (modelLooksLikeImageGen(model.name, caps)) {
        hits.push({ node, model: model.name });
      }
    }
  }
  const poolSource = forced.length ? forced : hits;
  if (!poolSource.length) return null;
  const local = poolSource.filter(h => !isFrontierNode(h.node));
  const pool = local.length ? local : poolSource;
  pool.sort((a, b) => {
    const vram = (b.node.hardware?.vramGB || 0) - (a.node.hardware?.vramGB || 0);
    if (vram) return vram;
    const sa = a.node.benchmarks?.[a.model]?.evalTokPerSec || 0;
    const sb = b.node.benchmarks?.[b.model]?.evalTokPerSec || 0;
    return sb - sa;
  });
  return pool[0];
}

export function placeholderSvg(prompt: string): string {
  const safe = prompt.replace(/[<>&]/g, ' ').slice(0, 180);
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="800" height="600" viewBox="0 0 800 600">
  <rect width="800" height="600" fill="#1e1e24"/>
  <rect x="24" y="24" width="752" height="552" fill="none" stroke="#6366f1" stroke-width="2"/>
  <text x="400" y="280" fill="#e4e4e7" font-family="Segoe UI, sans-serif" font-size="22" text-anchor="middle">Placeholder image</text>
  <text x="400" y="320" fill="#a1a1aa" font-family="Segoe UI, sans-serif" font-size="14" text-anchor="middle">${safe}</text>
</svg>
`;
}
