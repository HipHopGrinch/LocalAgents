import { AgentPersona, AppSettings, HardwareProfile, NodeConfig } from '../types';
import { normalizeClusterNodes } from '../lib/tools';

export const SETTINGS_VERSION = 6;

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

/** Generic hardware used when merging incomplete node records. */
export const DEFAULT_HARDWARE: HardwareProfile = {
  cpu: 'Generic CPU',
  gpu: 'Generic GPU',
  vramGB: 8,
  gpuBandwidthGBs: 300,
  ramGB: 16,
  ramBandwidthGBs: 50,
  reserveVramGB: 1,
  kvCacheType: 'f16'
};

/** No seeded endpoints — add nodes manually in Hardware Settings. */
export const DEFAULT_NODES: NodeConfig[] = [];

export const DEFAULT_AGENTS: AgentPersona[] = [
  {
    id: 'coder',
    handle: 'coder',
    name: 'Lead Coder',
    role: 'Assumes the stack and implements it. Gemma 4 12B is the recommended local model when installed.',
    endpointId: '',
    model: 'qwen2.5-coder:7b',
    temperature: 0.2,
    numCtx: 16384,
    toolsEnabled: true,
    autoApproveWrites: true,
    autoApproveCommands: false,
    systemPrompt: `You are the lead software engineer in an autonomous IDE. Assume what the user wants and do it. Use tool tags (<write_file>, <edit_file>, <run_command>, <web_search>, <generate_image>) to create files, install missing toolchains, search docs, and generate images. Do not reply with only markdown code blocks.

Match the delivery they asked for: a browser site is index.html, styles.css, and app.js unless they asked for React or TypeScript or the repo is already that stack. Python, Go, Rust, and Electron get that language's real project files plus a build or run command.

If an APPROVED PLAN is provided, follow that locked option exactly. Clarify only when two stacks are equally plausible and no plan is locked. Gemma 4 12B is a strong local default when it is installed; use whatever model this node actually has.`
  },
  {
    id: 'planner',
    handle: 'planner',
    name: 'Architect',
    role: 'Plans first with clear options; Coder implements after you pick',
    endpointId: '',
    model: 'qwen2.5-coder:7b',
    temperature: 0.4,
    numCtx: 16384,
    toolsEnabled: true,
    autoApproveWrites: false,
    autoApproveCommands: false,
    systemPrompt: `You are a software architect in Planner mode. Explore the codebase with read_file, list_dir, and search when helpful, then produce a concrete implementation plan: intent, assumptions, phases/files, and 2–4 numbered options with short tradeoffs.

Bend over backwards to match the user's delivery goal (e.g. "open in browser" → prefer static HTML unless they ask for React). Ask only architecture-changing decisions — do not spam questions. Do NOT write the deliverable files yet; wait for the user to pick an option. Always end with a <plan_options> XML block the UI can parse.`
  },
  {
    id: 'reviewer',
    handle: 'reviewer',
    name: 'Reviewer',
    role: 'Finds bugs, security issues and edge cases in code or diffs',
    endpointId: '',
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
    endpointId: '',
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
  uiScale: 1.0,
  recentWorkspaces: [],
  conversations: [],
  activeConversationId: undefined,
  searxngUrl: ''
};

/** Merge persisted settings over defaults so new fields added in later versions get sane values. */
export function mergeSettings(saved: Partial<AppSettings> | null): AppSettings {
  if (!saved) return structuredClone(DEFAULT_SETTINGS);

  const nodes = Array.isArray(saved.nodes) ? saved.nodes : DEFAULT_NODES;
  const uiScale = typeof saved.uiScale === 'number' && saved.uiScale >= 0.7 && saved.uiScale <= 2.5
    ? saved.uiScale
    : 1.0;

  return {
    ...DEFAULT_SETTINGS,
    ...saved,
    version: SETTINGS_VERSION,
    uiScale,
    nodes: normalizeClusterNodes(
      nodes.map(n => ({
        ...n,
        hardware: { ...DEFAULT_HARDWARE, ...n.hardware }
      }))
    ),
    agents: (saved.agents?.length ? saved.agents : DEFAULT_AGENTS).map(a => {
      const def =
        DEFAULT_AGENTS.find(d => d.id === a.id || d.handle === a.handle) || DEFAULT_AGENTS[0];
      // Refresh built-in planner/coder prompts so Planner→Coder workflow stays current
      const refreshPrompt = a.handle === 'planner' || a.handle === 'coder' || a.id === 'planner' || a.id === 'coder';
      return {
        ...def,
        ...a,
        systemPrompt: refreshPrompt ? def.systemPrompt : a.systemPrompt || def.systemPrompt
      };
    }),
    conversations: Array.isArray(saved.conversations) ? saved.conversations : []
  };
}
