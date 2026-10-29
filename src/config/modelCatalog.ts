/**
 * Curated Ollama model catalog used by the Model Hub recommender.
 *
 * - sizeGB: exact download size from registry.ollama.ai manifests (verified 2026-10-29).
 *   The Model Hub can re-verify any tag live via "Check registry".
 * - paramsB / activeB: total vs active parameters (active < total for MoE models -> much faster per token).
 * - kvKB: approx KV-cache KB per token at f16 (layers * kv_heads * head_dim * 4 bytes).
 *   Omitted where the architecture isn't known; a conservative heuristic is used instead.
 * - quality: subjective 1-10 suitability per task (relative ranking, not a benchmark).
 */

export type TaskId = 'agent' | 'coding' | 'reasoning' | 'review' | 'autocomplete' | 'embedding' | 'vision' | 'chat';

export const TASKS: { id: TaskId; label: string; description: string; minTps: number }[] = [
  { id: 'agent', label: 'Agentic Coding', description: 'Tool use, multi-file edits, autonomous loops', minTps: 25 },
  { id: 'coding', label: 'Code Generation', description: 'Writing / refactoring code in chat', minTps: 20 },
  { id: 'reasoning', label: 'Planning & Reasoning', description: 'Architecture, debugging, step-by-step thinking', minTps: 15 },
  { id: 'review', label: 'Code Review', description: 'Bug hunting, security, diff critique', minTps: 20 },
  { id: 'autocomplete', label: 'Autocomplete (FIM)', description: 'Inline fill-in-the-middle completions; needs speed', minTps: 60 },
  { id: 'embedding', label: 'Embeddings / RAG', description: 'Codebase indexing & semantic search', minTps: 0 },
  { id: 'vision', label: 'Vision', description: 'Screenshots, UI mockups, diagrams', minTps: 15 },
  { id: 'chat', label: 'Fast Utility', description: 'Commit messages, docstrings, quick Q&A', minTps: 30 }
];

export interface CatalogModel {
  tag: string;
  family: string;
  paramsB: number;
  activeB?: number;
  sizeGB: number;
  contextMax: number;
  kvKB?: number;
  caps: ('tools' | 'thinking' | 'vision' | 'fim' | 'embedding')[];
  quality: Partial<Record<TaskId, number>>;
  notes: string;
}

export const MODEL_CATALOG: CatalogModel[] = [
  // ---------------- Frontier-ish coding / agentic ----------------
  {
    tag: 'qwen3-coder-next:latest', family: 'Qwen3-Coder-Next', paramsB: 80, activeB: 3, sizeGB: 51.74, contextMax: 262144, kvKB: 25,
    caps: ['tools'], quality: { agent: 10, coding: 10, review: 8.5, reasoning: 8 },
    notes: 'Large MoE with few active params; strongest local agentic coder if you have RAM for offload.'
  },
  {
    tag: 'qwen3.8:27b', family: 'Qwen3.8', paramsB: 27, sizeGB: 17.74, contextMax: 262144,
    caps: ['tools', 'thinking', 'vision'], quality: { agent: 9, coding: 9, reasoning: 9, review: 8.5, vision: 8, chat: 8.5 },
    notes: 'Dense all-rounder; excellent coding + reasoning. Needs 20GB+ for full GPU.'
  },
  {
    tag: 'devstral-small-2:latest', family: 'Devstral Small 2', paramsB: 24, sizeGB: 15.18, contextMax: 393216, kvKB: 164,
    caps: ['tools', 'vision'], quality: { agent: 9, coding: 8.5, review: 7.5 },
    notes: 'Tuned specifically for agentic software engineering & tool-call consistency.'
  },
  {
    tag: 'glm-4.7-flash:latest', family: 'GLM-4.7 Flash', paramsB: 30, activeB: 3, sizeGB: 19.02, contextMax: 131072,
    caps: ['tools', 'thinking'], quality: { agent: 8.5, coding: 8.5, reasoning: 8, review: 7.5, chat: 7.5 },
    notes: 'MoE with ~3B active: fast even when partially offloaded to system RAM.'
  },
  {
    tag: 'qwen3-coder:30b', family: 'Qwen3-Coder', paramsB: 30.5, activeB: 3.3, sizeGB: 18.56, contextMax: 262144, kvKB: 98,
    caps: ['tools'], quality: { agent: 8.5, coding: 8.5, review: 7, reasoning: 6.5 },
    notes: 'MoE (3.3B active). Great speed/quality; tolerates CPU offload well.'
  },
  {
    tag: 'qwen3.5:27b', family: 'Qwen3.5', paramsB: 27, sizeGB: 17.48, contextMax: 262144,
    caps: ['tools', 'thinking'], quality: { agent: 8.5, coding: 8.5, reasoning: 8.5, review: 8, chat: 8 },
    notes: 'Dense; previous-gen of Qwen3.8 27B.'
  },
  {
    tag: 'gpt-oss:20b', family: 'gpt-oss', paramsB: 21, activeB: 3.6, sizeGB: 13.79, contextMax: 131072, kvKB: 40,
    caps: ['tools', 'thinking'], quality: { reasoning: 8.5, agent: 7.5, coding: 7.5, review: 7.5, chat: 8 },
    notes: 'MXFP4 MoE; fits a 16GB card fully. Strong reasoning, adjustable thinking effort.'
  },
  {
    tag: 'gpt-oss:120b', family: 'gpt-oss', paramsB: 117, activeB: 5.1, sizeGB: 65.37, contextMax: 131072, kvKB: 60,
    caps: ['tools', 'thinking'], quality: { reasoning: 9.5, agent: 9, coding: 9, review: 9 },
    notes: 'Needs ~70GB+ combined VRAM+RAM.'
  },
  {
    tag: 'devstral:24b', family: 'Devstral', paramsB: 24, sizeGB: 14.33, contextMax: 131072, kvKB: 164,
    caps: ['tools'], quality: { agent: 8, coding: 7.5, review: 7 },
    notes: 'Original Devstral; superseded by devstral-small-2.'
  },
  {
    tag: 'mistral-small3.2:24b', family: 'Mistral Small 3.2', paramsB: 24, sizeGB: 15.18, contextMax: 131072, kvKB: 164,
    caps: ['tools', 'vision'], quality: { chat: 8, agent: 7, coding: 7, vision: 7.5, review: 7 },
    notes: 'Solid generalist with vision and reliable function calling.'
  },

  // ---------------- Qwen2.5-Coder (FIM capable) ----------------
  {
    tag: 'qwen2.5-coder:32b', family: 'Qwen2.5-Coder', paramsB: 32.8, sizeGB: 19.85, contextMax: 32768, kvKB: 262,
    caps: ['tools', 'fim'], quality: { coding: 8, review: 7.5, agent: 6.5, autocomplete: 6.5 },
    notes: 'Older but very solid dense coder.'
  },
  {
    tag: 'qwen2.5-coder:14b', family: 'Qwen2.5-Coder', paramsB: 14.8, sizeGB: 8.99, contextMax: 32768, kvKB: 196,
    caps: ['tools', 'fim'], quality: { coding: 7.5, review: 7, agent: 6, autocomplete: 7.5 },
    notes: 'Fits 12GB+ cards fully.'
  },
  {
    tag: 'qwen2.5-coder:7b', family: 'Qwen2.5-Coder', paramsB: 7.6, sizeGB: 4.68, contextMax: 32768, kvKB: 57,
    caps: ['tools', 'fim'], quality: { coding: 6.5, review: 6, agent: 5, autocomplete: 8, chat: 6 },
    notes: 'Fast; best FIM size/quality balance on mid GPUs.'
  },
  {
    tag: 'qwen2.5-coder:3b', family: 'Qwen2.5-Coder', paramsB: 3.1, sizeGB: 1.93, contextMax: 32768, kvKB: 36,
    caps: ['fim'], quality: { autocomplete: 7.5, coding: 4.5, chat: 4.5 },
    notes: 'Very fast inline completions.'
  },
  {
    tag: 'qwen2.5-coder:1.5b', family: 'Qwen2.5-Coder', paramsB: 1.5, sizeGB: 0.99, contextMax: 32768, kvKB: 28,
    caps: ['fim'], quality: { autocomplete: 6.5 },
    notes: 'Tiny autocomplete model (the -base variant is better for pure FIM).'
  },

  // ---------------- General / reasoning ----------------
  {
    tag: 'qwen3:30b', family: 'Qwen3', paramsB: 30.5, activeB: 3.3, sizeGB: 18.56, contextMax: 40960, kvKB: 98,
    caps: ['tools', 'thinking'], quality: { reasoning: 8, chat: 8, coding: 7.5, agent: 7, review: 7 },
    notes: 'MoE generalist with thinking mode.'
  },
  {
    tag: 'qwen3:14b', family: 'Qwen3', paramsB: 14.8, sizeGB: 9.28, contextMax: 40960, kvKB: 164,
    caps: ['tools', 'thinking'], quality: { reasoning: 7.5, chat: 7.5, coding: 7, agent: 6.5, review: 7 },
    notes: 'Dense; good thinking model for 12GB cards.'
  },
  {
    tag: 'qwen3:8b', family: 'Qwen3', paramsB: 8.2, sizeGB: 5.23, contextMax: 40960, kvKB: 147,
    caps: ['tools', 'thinking'], quality: { reasoning: 6.5, chat: 7, coding: 6, agent: 5.5, review: 6 },
    notes: 'Capable small thinker; fits 6-8GB cards.'
  },
  {
    tag: 'qwen3.5:9b', family: 'Qwen3.5', paramsB: 9, sizeGB: 6.55, contextMax: 262144,
    caps: ['tools', 'thinking'], quality: { agent: 7, coding: 7, reasoning: 7, review: 6.5, chat: 7.5 },
    notes: 'Best-in-class for 8GB-ish GPUs.'
  },
  {
    tag: 'qwen3.5:4b', family: 'Qwen3.5', paramsB: 4, sizeGB: 3.32, contextMax: 262144,
    caps: ['tools', 'thinking'], quality: { chat: 6.5, coding: 5.5, reasoning: 5.5, agent: 5 },
    notes: 'Fast utility model for small GPUs.'
  },
  {
    tag: 'deepseek-r1:32b', family: 'DeepSeek-R1 distill', paramsB: 32.8, sizeGB: 19.85, contextMax: 131072, kvKB: 262,
    caps: ['thinking'], quality: { reasoning: 8.5, review: 7.5, coding: 7 },
    notes: 'Long chain-of-thought; slow but thorough for debugging.'
  },
  {
    tag: 'deepseek-r1:14b', family: 'DeepSeek-R1 distill', paramsB: 14.8, sizeGB: 8.99, contextMax: 131072, kvKB: 196,
    caps: ['thinking'], quality: { reasoning: 7.5, review: 6.5, coding: 6.5 },
    notes: 'Reasoning model for 12GB cards.'
  },
  {
    tag: 'deepseek-r1:8b', family: 'DeepSeek-R1 distill', paramsB: 8.2, sizeGB: 5.23, contextMax: 131072, kvKB: 147,
    caps: ['thinking'], quality: { reasoning: 6.5, review: 5.5 },
    notes: 'Qwen3-8B based distill.'
  },
  {
    tag: 'phi4:14b', family: 'Phi-4', paramsB: 14.7, sizeGB: 9.05, contextMax: 16384, kvKB: 205,
    caps: [], quality: { reasoning: 7, chat: 7, coding: 6.5, review: 6.5 },
    notes: 'Strong STEM reasoning; 16K context limit.'
  },
  {
    tag: 'ministral-3:14b', family: 'Ministral 3', paramsB: 14, sizeGB: 9.08, contextMax: 131072,
    caps: ['tools'], quality: { chat: 7.5, agent: 6.5, coding: 6.5, reasoning: 6.5 },
    notes: 'Efficient Mistral generalist.'
  },
  {
    tag: 'ministral-3:8b', family: 'Ministral 3', paramsB: 8, sizeGB: 6.02, contextMax: 131072,
    caps: ['tools'], quality: { chat: 7, agent: 6, coding: 6 },
    notes: 'Fast tool-capable generalist.'
  },
  {
    tag: 'deepcoder:14b', family: 'DeepCoder', paramsB: 14.8, sizeGB: 8.99, contextMax: 131072, kvKB: 196,
    caps: ['thinking'], quality: { coding: 7, reasoning: 7 },
    notes: 'RL-tuned reasoning coder (competitive programming style).'
  },

  // ---------------- Gemma ----------------
  {
    tag: 'gemma4:31b', family: 'Gemma 4', paramsB: 31, sizeGB: 20.39, contextMax: 131072,
    caps: ['tools', 'vision', 'thinking'], quality: { chat: 9, vision: 9, reasoning: 8.5, coding: 8, review: 7.5, agent: 7.5 },
    notes: 'Top multimodal generalist; great for UI-mockup-to-code.'
  },
  {
    tag: 'gemma4:12b', family: 'Gemma 4', paramsB: 12, sizeGB: 8.02, contextMax: 131072,
    caps: ['tools', 'vision', 'thinking'], quality: { chat: 8, vision: 8, reasoning: 7, coding: 6.5, review: 6.5, agent: 6 },
    notes: 'Multimodal for 10-12GB cards.'
  },
  {
    tag: 'gemma4:e4b', family: 'Gemma 4', paramsB: 8, activeB: 4, sizeGB: 6.58, contextMax: 131072,
    caps: ['tools', 'vision', 'thinking'], quality: { chat: 6.5, vision: 7, coding: 5, reasoning: 5.5 },
    notes: 'Edge-optimized (effective 4B).'
  },
  {
    tag: 'gemma4:e2b', family: 'Gemma 4', paramsB: 5, activeB: 2, sizeGB: 4.59, contextMax: 131072,
    caps: ['tools', 'vision', 'thinking'], quality: { chat: 5.5, vision: 6 },
    notes: 'Edge-optimized (effective 2B).'
  },
  {
    tag: 'gemma3:27b', family: 'Gemma 3', paramsB: 27, sizeGB: 17.41, contextMax: 131072, kvKB: 120,
    caps: ['vision'], quality: { chat: 8, vision: 8, reasoning: 7, coding: 6.5 },
    notes: 'Previous-gen multimodal.'
  },
  {
    tag: 'gemma3:12b', family: 'Gemma 3', paramsB: 12, sizeGB: 8.16, contextMax: 131072, kvKB: 90,
    caps: ['vision'], quality: { chat: 7, vision: 7.5, coding: 5.5 },
    notes: 'Previous-gen multimodal.'
  },

  // ---------------- Small / fast utility ----------------
  {
    tag: 'phi4-mini:3.8b', family: 'Phi-4 mini', paramsB: 3.8, sizeGB: 2.49, contextMax: 131072, kvKB: 131,
    caps: ['tools'], quality: { chat: 5.5, reasoning: 5 },
    notes: 'Small and quick.'
  },
  {
    tag: 'granite4:3b', family: 'Granite 4', paramsB: 3, sizeGB: 2.1, contextMax: 131072,
    caps: ['tools'], quality: { chat: 5.5, agent: 4.5 },
    notes: 'Good tool calling for its size.'
  },
  {
    tag: 'llama3.2:3b', family: 'Llama 3.2', paramsB: 3.2, sizeGB: 2.02, contextMax: 131072, kvKB: 115,
    caps: ['tools'], quality: { chat: 5 },
    notes: 'Commit messages, summaries.'
  },
  {
    tag: 'starcoder2:7b', family: 'StarCoder2', paramsB: 7, sizeGB: 4.04, contextMax: 16384, kvKB: 66,
    caps: ['fim'], quality: { autocomplete: 6.5 },
    notes: 'Base FIM model, many languages.'
  },
  {
    tag: 'starcoder2:3b', family: 'StarCoder2', paramsB: 3, sizeGB: 1.71, contextMax: 16384, kvKB: 31,
    caps: ['fim'], quality: { autocomplete: 6 },
    notes: 'Small FIM model.'
  },

  // ---------------- Vision ----------------
  {
    tag: 'qwen3-vl:8b', family: 'Qwen3-VL', paramsB: 8.8, sizeGB: 6.19, contextMax: 262144,
    caps: ['vision', 'tools', 'thinking'], quality: { vision: 8.5, chat: 6.5 },
    notes: 'Best small vision model; screenshots, OCR, UI.'
  },
  {
    tag: 'qwen2.5vl:7b', family: 'Qwen2.5-VL', paramsB: 8.3, sizeGB: 5.97, contextMax: 128000,
    caps: ['vision'], quality: { vision: 7.5 },
    notes: 'Previous-gen vision.'
  },

  // ---------------- Embeddings ----------------
  {
    tag: 'qwen3-embedding:8b', family: 'Qwen3-Embedding', paramsB: 7.6, sizeGB: 4.68, contextMax: 32768, kvKB: 0,
    caps: ['embedding'], quality: { embedding: 9 },
    notes: 'Top-tier retrieval quality incl. code.'
  },
  {
    tag: 'qwen3-embedding:4b', family: 'Qwen3-Embedding', paramsB: 4, sizeGB: 2.5, contextMax: 32768, kvKB: 0,
    caps: ['embedding'], quality: { embedding: 8.5 },
    notes: 'Great quality/speed balance.'
  },
  {
    tag: 'qwen3-embedding:0.6b', family: 'Qwen3-Embedding', paramsB: 0.6, sizeGB: 0.64, contextMax: 32768, kvKB: 0,
    caps: ['embedding'], quality: { embedding: 7.5 },
    notes: 'Tiny, fast, long context.'
  },
  {
    tag: 'bge-m3:latest', family: 'BGE-M3', paramsB: 0.57, sizeGB: 1.16, contextMax: 8192, kvKB: 0,
    caps: ['embedding'], quality: { embedding: 7.5 },
    notes: 'Multilingual, 8K input.'
  },
  {
    tag: 'embeddinggemma:latest', family: 'EmbeddingGemma', paramsB: 0.3, sizeGB: 0.62, contextMax: 2048, kvKB: 0,
    caps: ['embedding'], quality: { embedding: 7.5 },
    notes: 'Small and strong.'
  },
  {
    tag: 'mxbai-embed-large:latest', family: 'mxbai', paramsB: 0.33, sizeGB: 0.67, contextMax: 512, kvKB: 0,
    caps: ['embedding'], quality: { embedding: 7 },
    notes: 'Short inputs only (512 tokens).'
  },
  {
    tag: 'nomic-embed-text:latest', family: 'Nomic Embed', paramsB: 0.14, sizeGB: 0.27, contextMax: 8192, kvKB: 0,
    caps: ['embedding'], quality: { embedding: 6.5 },
    notes: 'Tiny, classic choice.'
  }
];
