// ==========================================
// Cluster / hardware
// ==========================================

/** From Ollama `/api/show` — which think values the model accepts. */
export interface ModelThinkingInfo {
  values: Array<boolean | string>;
  default?: boolean | string;
}

/** Persisted per-model user prefs on a node. */
export interface ModelPref {
  /** Top-level Ollama `think` value; null = use model default */
  think?: boolean | string | null;
  /** Ollama `options.num_ctx` for this model on this node; omit = agent/default */
  numCtx?: number;
}

/** Cached `/api/show` metadata so we don't re-query on every status poll. */
export interface ModelMeta {
  thinking?: ModelThinkingInfo;
  capabilities?: string[];
  description?: string;
  fetchedAt?: number;
}

export interface OllamaModel {
  name: string;
  size: number;
  details?: {
    family?: string;
    parameter_size?: string;
    quantization_level?: string;
    context_length?: number;
  };
  capabilities?: string[];
  /** Short description / family blurb from Ollama show */
  description?: string;
  /** Controllable thinking metadata from Ollama show */
  thinking?: ModelThinkingInfo;
}

export interface LoadedModel {
  name: string;
  size: number;
  sizeVram: number;
  contextLength?: number;
  expiresAt?: string;
}

export interface HardwareProfile {
  cpu: string;
  gpu: string; // empty string = no usable GPU (CPU-only inference)
  vramGB: number;
  gpuBandwidthGBs: number; // memory bandwidth drives token generation speed
  ramGB: number;
  ramBandwidthGBs: number; // effective system RAM bandwidth (dual channel)
  reserveVramGB: number; // VRAM kept free for desktop / other apps
  kvCacheType: 'f16' | 'q8_0' | 'q4_0'; // mirrors OLLAMA_KV_CACHE_TYPE on that node (needs flash attention)
}

export interface BenchmarkResult {
  model: string;
  nodeId: string;
  evalTokens: number;
  evalTokPerSec: number;
  promptTokens: number;
  promptTokPerSec: number;
  loadMs: number;
  totalMs: number;
  isEmbedding?: boolean;
  embeddingDim?: number;
  error?: string;
  /** true for seeded estimates; cleared when a live benchmark succeeds */
  provisional?: boolean;
  measuredAt?: number;
}

export type NodeRole = 'coder' | 'reviewer' | 'docs' | 'planner';

/** Persisted node configuration */
export interface NodeConfig {
  id: string;
  name: string;
  url: string;
  type?: 'ollama' | 'openai'; // 'ollama' for local Ollama, 'openai' for frontier models (Grok, OpenRouter, OpenAI)
  apiKey?: string;
  dnsAlias?: string;
  /** Soft routing hints for auto-endpoint selection */
  roles?: NodeRole[];
  hardware: HardwareProfile;
  benchmarks?: Record<string, BenchmarkResult>; // model -> measured benchmark stats
  disabledModels?: string[]; // models toggled OFF by user on this node
  activeModel?: string; // user-selected primary model for this endpoint node
  /** Cached Ollama /api/show data (thinking support, description) */
  modelMeta?: Record<string, ModelMeta>;
  /** User prefs per model name (e.g. think on/off) */
  modelPrefs?: Record<string, ModelPref>;
  /** Optional forced image-generation model. Empty = auto-detect. */
  imageModel?: string;
  /** This API key is a free tier. Models on the node are short assists, not writers. */
  freeTier?: boolean;
  /** Assist calls allowed per local day. Default 20. */
  freeTierDailyCap?: number;
  /** Calls already made on the local calendar day. */
  freeTierUsage?: { day: string; count: number };
}

/** Live node status (merged into NodeConfig at runtime) */
export interface NodeStatus {
  online: boolean;
  latency: number | null;
  version?: string;
  models: OllamaModel[];
  loaded: LoadedModel[];
  error?: string;
}

export type EndpointNode = NodeConfig & NodeStatus;

// ==========================================
// Agents
// ==========================================

export interface AgentPersona {
  id: string;
  handle: string; // @handle routing in chat
  name: string;
  role: string;
  endpointId: string;
  model: string;
  systemPrompt: string;
  temperature: number;
  numCtx: number;
  toolsEnabled: boolean;
  autoApproveWrites: boolean;
  autoApproveCommands: boolean;
}

/** A single architecture choice offered by the Planner. */
export interface PlanOption {
  id: string;
  title: string;
  description: string;
  /** stop = record the choice and do not start the coder. copy = clipboard. paid = confirm a paid API call. */
  action?: 'run' | 'stop' | 'copy' | 'paid';
}

/** Locked plan after the user picks an option — drives Coder / Swarm execution. */
export interface ApprovedPlan {
  summary: string;
  chosenOptionId: string;
  chosenOptionTitle: string;
  chosenOptionDescription: string;
  allOptions: PlanOption[];
  originalUserRequest: string;
  approvedAt: number;
  /** Full planner markdown (options block stripped) for agent context */
  planMarkdown?: string;
}

/** One agent chat thread (Cursor/VS Code-style conversation). */
export interface ChatConversation {
  id: string;
  title: string;
  workspacePath: string;
  agentId: string;
  messages: ChatMessage[];
  /** Set when user confirms a Planner option; cleared on new chat / new plan request */
  approvedPlan?: ApprovedPlan | null;
  createdAt: number;
  updatedAt: number;
}

export interface AppSettings {
  version: number;
  nodes: NodeConfig[];
  agents: AgentPersona[];
  lastWorkspace?: string;
  keepAlive: string; // e.g. "30m"
  maxAgentSteps: number;
  commandTimeoutSec: number;
  pollIntervalSec: number;
  estimateContext: number; // context length used for VRAM estimates in Model Hub
  localTokensGenerated: number;
  frontierTokensUsed: number;
  explorerWidth?: number;
  chatWidth?: number;
  /** UI & Text scaling factor (0.75 to 2.0, default 1.0) */
  uiScale?: number;
  /** SearXNG base URL for the web_search tool. Empty = search unavailable. */
  searxngUrl?: string;
  /** Recently opened project folders, newest first */
  recentWorkspaces?: string[];
  /** Persisted chat threads (scoped by workspacePath at runtime) */
  conversations?: ChatConversation[];
  activeConversationId?: string;
}

// ==========================================
// Workspace / editor
// ==========================================

export interface WorkspaceFile {
  name: string;
  path: string;
  isDirectory: boolean;
}

export interface OpenTab {
  path: string;
  name: string;
  content: string;
  originalContent: string;
  isDirty: boolean;
  language: string;
}

// ==========================================
// Chat / tools
// ==========================================

export type ToolName =
  | 'read_file'
  | 'list_dir'
  | 'search'
  | 'write_file'
  | 'edit_file'
  | 'run_command'
  | 'read_terminal'
  | 'web_search'
  | 'generate_image';

export type ToolStatus = 'pending' | 'awaiting_approval' | 'running' | 'done' | 'rejected' | 'error';

export interface ToolCall {
  id: string;
  name: ToolName;
  args: Record<string, string>;
  body?: string; // raw block content (file content / edit blocks / command)
  status: ToolStatus;
  result?: string;
  // Prepared for write/edit so the user can review a diff before approving
  preview?: { absPath: string; original: string; proposed: string; isNew: boolean };
}

export interface ChatStats {
  tokensPerSec?: number;
  evalCount?: number;
  promptTokens?: number;
  loadMs?: number;
  numCtx?: number;
}

export interface PipelineStep {
  nodeId: string;
  nodeName: string;
  modelName?: string;
  targetFile?: string;
  agentHandle: string;
  role: string;
  status: 'pending' | 'running' | 'completed' | 'failed';
  content: string;
  stats?: ChatStats;
  toolCalls?: ToolCall[];
}

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant' | 'tool';
  raw: string; // exact text sent to / received from the model
  display: string; // text shown in the UI (tool tags stripped)
  thinking?: string;
  agentId?: string;
  endpointId?: string;
  endpointName?: string;
  model?: string;
  timestamp: string;
  toolCalls?: ToolCall[];
  stats?: ChatStats;
  error?: string;
  notice?: string;
  isEscalation?: boolean;
  pipelineSteps?: PipelineStep[];
  /** Screenshot / image attachments as data URLs (for UI + vision models) */
  images?: string[];
  /** Planner proposal: clickable architecture options parsed from the reply */
  planOptions?: PlanOption[];
  /** Short plan text kept alongside options for Coder context */
  planSummary?: string;
  /** Set on the proposal message once the user picks an option */
  selectedPlanOptionId?: string;
  /** Set on the user confirmation message when they choose an option */
  chosenPlanOptionId?: string;
  /** Which persona drove this turn (survives agent auto-switch Planner → Coder) */
  personaHandle?: string;
}

// ==========================================
// IPC bridge
// ==========================================

export interface ChatEvent {
  requestId: string;
  type: 'chunk' | 'done' | 'error' | 'aborted';
  content?: string;
  thinking?: string;
  error?: string;
  stats?: {
    evalCount?: number;
    evalDuration?: number;
    promptEvalCount?: number;
    promptEvalDuration?: number;
    loadDuration?: number;
    totalDuration?: number;
    doneReason?: string;
  };
}

export interface PullEvent {
  requestId: string;
  type: 'progress' | 'done' | 'error' | 'aborted';
  status?: string;
  completed?: number;
  total?: number;
  error?: string;
}

export interface ToolExecResult {
  content?: string;
  path?: string;
  exists?: boolean;
  exitCode?: number;
  error?: string;
}

export interface DetectedHardware {
  cpu: string;
  ramGB: number;
  gpu: string;
  vramGB: number;
  ramMTs: number;
  ramBandwidthGBs: number;
}

export interface ElectronAPI {
  // Zoom & UI Scaling
  setZoomFactor?: (factor: number) => void;
  getZoomFactor?: () => number;

  loadSettings: () => Promise<AppSettings | null>;
  saveSettings: (s: AppSettings) => Promise<{ success?: boolean; error?: string }>;
  settingsPath: () => Promise<string>;
  openSettingsFolder: () => Promise<{ success?: boolean; path?: string; error?: string }>;
  writeLog: (level: string, message: string) => Promise<{ success?: boolean; error?: string }>;
  readLogTail: () => Promise<{ success?: boolean; text?: string; path?: string; error?: string }>;
  logsPath: () => Promise<string>;
  openLogsFolder: () => Promise<{ success?: boolean; path?: string; error?: string }>;
  /** Encrypt node configs to a passphrase-protected .enc file (AES-256-GCM + scrypt). */
  exportNodes: (
    nodes: NodeConfig[],
    passphrase: string
  ) => Promise<{ success?: boolean; canceled?: boolean; path?: string; nodeCount?: number; error?: string }>;
  /** Decrypt a node export file; returns NodeConfig[] for the renderer to merge/replace. */
  importNodes: (
    passphrase: string
  ) => Promise<{
    success?: boolean;
    canceled?: boolean;
    path?: string;
    nodes?: NodeConfig[];
    nodeCount?: number;
    error?: string;
  }>;

  getDefaultWorkspace: () => Promise<string>;
  loadProjectChats: (
    root: string
  ) => Promise<{ conversations: ChatConversation[]; activeConversationId?: string | null }>;
  saveProjectChats: (
    root: string,
    payload: { conversations: ChatConversation[]; activeConversationId?: string | null }
  ) => Promise<{ success?: boolean; error?: string }>;
  selectFolder: () => Promise<string | null>;
  readDir: (dirPath: string) => Promise<WorkspaceFile[] | { error: string }>;
  readFile: (filePath: string) => Promise<{ content?: string; error?: string }>;
  writeFile: (filePath: string, content: string) => Promise<{ success?: boolean; error?: string }>;
  createFile: (filePath: string) => Promise<{ success?: boolean; error?: string }>;
  createFolder: (folderPath: string) => Promise<{ success?: boolean; error?: string }>;
  deleteTarget: (targetPath: string) => Promise<{ success?: boolean; error?: string }>;
  revealInExplorer: (targetPath: string) => Promise<void>;

  execTool: (root: string, name: string, args: Record<string, unknown>) => Promise<ToolExecResult>;
  typecheckWorkspace: (
    root: string,
    opts?: { mode?: 'contract' | 'workspace'; file?: string; timeoutMs?: number }
  ) => Promise<{
    ok: boolean;
    skipped?: boolean;
    code?: number;
    output?: string;
    error?: string;
    timedOut?: boolean;
    mode?: string;
  }>;

  executeCommand: (command: string, cwd?: string) => Promise<{ code?: number }>;
  killCommand: () => Promise<{ success: boolean }>;
  getTerminalBuffer: (opts?: { maxChars?: number }) => Promise<{ content: string; running: boolean; chars: number }>;
  clearTerminalBuffer: () => Promise<{ success: boolean }>;
  onTerminalOutput: (cb: (text: string) => void) => () => void;
  onTerminalState: (cb: (s: { running: boolean }) => void) => () => void;

  clusterStatus: (nodes: { id: string; url: string; type?: 'ollama' | 'openai'; apiKey?: string }[]) => Promise<Record<string, NodeStatus>>;
  chat: (requestId: string, url: string, body: unknown, nodeType?: 'ollama' | 'openai', apiKey?: string) => Promise<void>;
  benchmarkModel: (node: NodeConfig, model: string) => Promise<BenchmarkResult>;
  onChatEvent: (cb: (e: ChatEvent) => void) => () => void;
  pullModel: (requestId: string, url: string, model: string) => Promise<void>;
  onPullEvent: (cb: (e: PullEvent) => void) => () => void;
  abortStream: (requestId: string) => Promise<{ success: boolean }>;
  deleteModel: (url: string, model: string) => Promise<{ success?: boolean; error?: string }>;
  setKeepAlive: (url: string, model: string, keepAlive: string | number) => Promise<{ success?: boolean; error?: string }>;
  registryLookup: (tag: string) => Promise<{ exists?: boolean; sizeBytes?: number; error?: string }>;
  showModel: (url: string, model: string) => Promise<{
    capabilities?: string[];
    description?: string;
    thinking?: ModelThinkingInfo;
    error?: string;
  }>;
  webSearch: (baseUrl: string, query: string) => Promise<{ content?: string; error?: string }>;
  generateImage: (
    url: string,
    model: string,
    prompt: string
  ) => Promise<{ ok?: boolean; imageBase64?: string; mime?: string; error?: string }>;

  detectHardware: () => Promise<DetectedHardware>;
}

declare global {
  interface Window {
    electronAPI: ElectronAPI;
  }
}
