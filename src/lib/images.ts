import { EndpointNode, OllamaModel } from '../types';
import { MODEL_CATALOG } from '../config/modelCatalog';

const MAX_EDGE = 1920;
const JPEG_QUALITY = 0.88;

/** Strip `data:image/...;base64,` so Ollama gets raw base64. */
export function toOllamaBase64(dataUrlOrBase64: string): string {
  const i = dataUrlOrBase64.indexOf('base64,');
  return i >= 0 ? dataUrlOrBase64.slice(i + 7) : dataUrlOrBase64;
}

export function isDataUrl(s: string): boolean {
  return /^data:image\//i.test(s);
}

/** Downscale large screenshots so vision models stay responsive. */
export async function compressImageBlob(blob: Blob): Promise<{ dataUrl: string; mime: string }> {
  const bitmap = await createImageBitmap(blob);
  try {
    let { width, height } = bitmap;
    const scale = Math.min(1, MAX_EDGE / Math.max(width, height));
    width = Math.max(1, Math.round(width * scale));
    height = Math.max(1, Math.round(height * scale));

    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Canvas unavailable');
    ctx.drawImage(bitmap, 0, 0, width, height);

    const mime = blob.type === 'image/png' && scale === 1 ? 'image/png' : 'image/jpeg';
    const dataUrl = canvas.toDataURL(mime, mime === 'image/jpeg' ? JPEG_QUALITY : undefined);
    return { dataUrl, mime };
  } finally {
    bitmap.close();
  }
}

export async function fileToChatImage(file: Blob): Promise<string> {
  const { dataUrl } = await compressImageBlob(file);
  return dataUrl;
}

export function modelSupportsVision(
  modelName: string,
  node?: EndpointNode,
  live?: Pick<OllamaModel, 'name' | 'capabilities'>
): boolean {
  const caps = live?.capabilities || node?.modelMeta?.[modelName]?.capabilities || [];
  if (caps.includes('vision')) return true;

  const catalog = MODEL_CATALOG.find(m => {
    const a = m.tag.toLowerCase();
    const b = modelName.toLowerCase();
    return a === b || b.startsWith(a.split(':')[0] + ':') || a.startsWith(b.split(':')[0] + ':');
  });
  if (catalog?.caps.includes('vision')) return true;

  const n = modelName.toLowerCase();
  return /gemma4|gemma3|llava|moondream|minicpm-v|qwen2\.5-vl|qwen3-vl|llama3\.2-vision|vision/.test(n);
}
