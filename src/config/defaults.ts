import { AgentPersona, AppSettings, HardwareProfile, NodeConfig } from '../types';

export const SETTINGS_VERSION = 4;

/** Memory bandwidth presets (GB/s). Bandwidth, not TFLOPs, is what limits local token generation speed. */
export const GPU_PRESETS: { name: string; vramGB: number; bandwidth: number }[] = [
  { name: 'RTX 5090', vramGB: 32, bandwidth: 1792 },
  { name: 'RTX 5080', vramGB: 16, bandwidth: 960 },
  { name: 'RTX 5070 Ti', vramGB: 16, bandwidth: 896 },
  { name: 'RTX 5070', vramGB: 12, bandwidth: 672 },
  { name: 'RTX 5060 Ti 16GB', vramGB: 16, bandwidth: 448 },
  { name: 'RTX 4090', vramGB: 24, bandwidth: 1008 },
  { name: 'RTX 4080', vramGB: 16, bandwidth: 717 },
  { name: 'RTX 4070 Ti', vramGB: 12, bandwidth: 504 },
  { name: 'RTX 4060 Ti 16GB', vramGB: 16, bandwidth: 288 },
  { name: 'RTX 3090', vramGB: 24, bandwidth: 936 },
  { name: 'RTX 3080', vramGB: 10, bandwidth: 760 },
  { name: 'RTX 3060 12GB', vramGB: 12, bandwidth: 360 },
  { name: 'RTX 3060 Laptop (6GB)', vramGB: 6, bandwidth: 336 },
  { name: 'GTX 1080 Ti', vramGB: 11, bandwidth: 484 },
  { name: 'GTX 1080', vramGB: 8, bandwidth: 320 },
  { name: 'Radeon RX 7900 XTX', vramGB: 24, bandwidth: 960 },
  { name: 'Radeon RX 9070 XT', vramGB: 16, bandwidth: 640 }
];

export const RAM_PRESETS: { name: string; bandwidth: number }[] = [
  { name: 'DDR5-6400 dual channel', bandwidth: 102 },
  { name: 'DDR5-6000 dual channel', bandwidth: 96 },
  { name: 'DDR5-5600 dual channel', bandwidth: 90 },
  { name: 'DDR4-3600 dual channel', bandwidth: 58 },
  { name: 'DDR4-3200 dual channel', bandwidth: 51 },
  { name: 'DDR4-2666 dual channel', bandwidth: 43 }
];

export function guessGpuBandwidth(gpuName: string): number | undefined {
  const n = gpuName.toLowerCase();
  const hit = GPU_PRESETS.find(p => n.includes(p.name.toLowerCase().replace(/ \(.*\)$/, '')));
  return hit?.bandwidth;
}

const hw = (h: HardwareProfile) => h;

/**
 * Example cluster templates — replace URLs with your machines.
 * Tiers: high-end gaming (16–24GB VRAM), mid-range desktop (8–12GB), budget laptop (6GB).
 */
export const DEFAULT_NODES: NodeConfig[] = [
  {
    id: 'gaming-pc',
    name: 'High-End Gaming PC',
    url: 'http://127.0.0.1:11434',
    activeModel: 'qwen2.5-coder:7b',
    disabledModels: [],
    hardware: hw({
      cpu: 'Ryzen 7 / Core i7 (example)',
      gpu: 'RTX 4090',
      vramGB: 24,
      gpuBandwidthGBs: 1008,
      ramGB: 64,
      ramBandwidthGBs: 96,
      reserveVramGB: 1.5,
      kvCacheType: 'f16'
    }),
    roles: ['coder', 'planner'],
    benchmarks: {
      'qwen2.5-coder:7b': {
        model: 'qwen2.5-coder:7b',
        nodeId: 'gaming-pc',
        evalTokens: 64,
        evalTokPerSec: 120,
        promptTokens: 38,
        promptTokPerSec: 450,
        loadMs: 3000,
        totalMs: 3500,
        provisional: true
      }
    }
  },
  {
    id: 'midrange-pc',
    name: 'Mid-Range PC',
    url: 'http://192.168.1.20:11434',
    dnsAlias: 'midrange-pc',
    activeModel: 'qwen2.5-coder:7b-instruct',
    disabledModels: [],
    roles: ['docs', 'planner'],
    hardware: hw({
      cpu: 'Ryzen 5 / Core i5 (example)',
      gpu: 'RTX 3060 12GB',
      vramGB: 12,
      gpuBandwidthGBs: 360,
      ramGB: 32,
      ramBandwidthGBs: 51,
      reserveVramGB: 0.5,
      kvCacheType: 'f16'
    }),
    benchmarks: {
      'qwen2.5-coder:7b-instruct': {
        model: 'qwen2.5-coder:7b-instruct',
        nodeId: 'midrange-pc',
        evalTokens: 40,
        evalTokPerSec: 55,
        promptTokens: 30,
        promptTokPerSec: 180,
        loadMs: 4500,
        totalMs: 5200,
        provisional: true
      }
    }
  },
  {
    id: 'budget-laptop',
    name: 'Budget Laptop',
    url: 'http://192.168.1.30:11434',
    dnsAlias: 'budget-laptop',
    activeModel: 'qwen2.5-coder:3b',
    disabledModels: [],
    roles: ['reviewer'],
    hardware: hw({
      cpu: 'Laptop Ryzen 5 / Core i5 (example)',
      gpu: 'RTX 3060 Laptop (6GB)',
      vramGB: 6,
      gpuBandwidthGBs: 336,
      ramGB: 16,
      ramBandwidthGBs: 51,
      reserveVramGB: 0.6,
      kvCacheType: 'f16'
    }),
    benchmarks: {
      'qwen2.5-coder:3b': {
        model: 'qwen2.5-coder:3b',
        nodeId: 'budget-laptop',
        evalTokens: 20,
        evalTokPerSec: 80,
        promptTokens: 30,
        promptTokPerSec: 150,
        loadMs: 6000,
        totalMs: 6500,
        provisional: true
      }
    }
  },
  {
    id: 'xai-grok',
    name: 'xAI Grok (Frontier API)',
    url: 'https://api.x.ai/v1',
    type: 'openai',
    apiKey: '',
    dnsAlias: 'grok-cloud',
    roles: ['planner'],
    hardware: hw({
      cpu: 'Cloud Frontier Cluster',
      gpu: 'xAI Colossus Cluster',
      vramGB: 80,
      gpuBandwidthGBs: 3350,
      ramGB: 512,
      ramBandwidthGBs: 1000,
      reserveVramGB: 0,
      kvCacheType: 'f16'
    })
  }
];

export const DEFAULT_AGENTS: AgentPersona[] = [
  {
    id: 'coder',
    handle: 'coder',
    name: 'Lead Coder',
    role: 'Implements features, multi-file edits, runs builds/tests',
    endpointId: 'gaming-pc',
    model: 'qwen2.5-coder:7b',
    temperature: 0.2,
    numCtx: 16384,
    toolsEnabled: true,
    autoApproveWrites: true,
    autoApproveCommands: false,
    systemPrompt: `You are the lead software engineer in an autonomous IDE. When the user asks you to build, create, or write code, you MUST use tool tags (<write_file path="..."> or <edit_file path="...">) to produce the files directly on the user's machine. If the user asks for a project, webpage, or script, immediately write the complete files using <write_file path="index.html">, etc. Do not merely output conversational markdown code blocks. Always make clean, working implementations.`
  },
  {
    id: 'planner',
    handle: 'planner',
    name: 'Architect',
    role: 'Breaks down tasks, designs approaches, explains trade-offs',
    endpointId: 'gaming-pc',
    model: 'qwen2.5-coder:7b',
    temperature: 0.4,
    numCtx: 16384,
    toolsEnabled: true,
    autoApproveWrites: false,
    autoApproveCommands: false,
    systemPrompt: `You are a software architect. Explore the codebase with read_file, list_dir, and search, then produce a concrete, numbered implementation plan: which files change, what changes in each, risks, and how to verify. When asked to implement, emit the file tools directly.`
  },
  {
    id: 'reviewer',
    handle: 'reviewer',
    name: 'Reviewer',
    role: 'Finds bugs, security issues and edge cases in code or diffs',
    endpointId: 'budget-laptop',
    model: 'qwen2.5-coder:7b-instruct',
    temperature: 0.1,
    numCtx: 16384,
    toolsEnabled: true,
    autoApproveWrites: false,
    autoApproveCommands: false,
    systemPrompt: `You are a meticulous code reviewer. Look for correctness bugs, unhandled edge cases, security problems, race conditions and performance pitfalls. Provide actionable diffs using <edit_file> or concise findings with line numbers.`
  },
  {
    id: 'docs',
    handle: 'docs',
    name: 'Explainer',
    role: 'Explains code, writes docs, tests and commit messages',
    endpointId: 'midrange-pc',
    model: 'qwen2.5-coder:7b-instruct',
    temperature: 0.3,
    numCtx: 16384,
    toolsEnabled: true,
    autoApproveWrites: true,
    autoApproveCommands: false,
    systemPrompt: `You explain code clearly and write documentation, docstrings, unit tests and commit messages. When generating new tests or documentation files, use <write_file path="..."> so they are saved to the workspace.`
  }
];

export const DEFAULT_SETTINGS: AppSettings = {
  version: SETTINGS_VERSION,
  nodes: DEFAULT_NODES,
  agents: DEFAULT_AGENTS,
  keepAlive: '30m',
  maxAgentSteps: 12,
  commandTimeoutSec: 180,
  pollIntervalSec: 15,
  estimateContext: 16384,
  localTokensGenerated: 0,
  frontierTokensUsed: 0,
  explorerWidth: 240,
  chatWidth: 420,
  conversations: [],
  activeConversationId: undefined
};

/** Merge persisted settings over defaults so new fields added in later versions get sane values. */
export function mergeSettings(saved: Partial<AppSettings> | null): AppSettings {
  if (!saved) return structuredClone(DEFAULT_SETTINGS);
  return {
    ...DEFAULT_SETTINGS,
    ...saved,
    version: SETTINGS_VERSION,
    nodes: (saved.nodes?.length ? saved.nodes : DEFAULT_NODES).map(n => ({
      ...n,
      hardware: { ...DEFAULT_NODES[0].hardware, ...n.hardware }
    })),
    agents: (saved.agents?.length ? saved.agents : DEFAULT_AGENTS).map(a => ({
      ...DEFAULT_AGENTS[0],
      ...a
    })),
    conversations: Array.isArray(saved.conversations) ? saved.conversations : []
  };
}
