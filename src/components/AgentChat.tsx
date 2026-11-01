import React, { useState, useRef, useEffect } from 'react';
import {
  AgentPersona,
  ApprovedPlan,
  EndpointNode,
  ChatMessage,
  ToolCall,
  OpenTab,
  PipelineStep,
  ChatConversation,
  ExecutionQueue,
  PlannerPlan,
  PlanOption,
  WorkspaceFile
} from '../types';
import {
  Send,
  Square,
  Cpu,
  Sparkles,
  Paperclip,
  Zap,
  Cloud,
  Share2,
  Plus,
  History,
  Trash2,
  MessageSquarePlus,
  Brain,
  ImagePlus,
  X,
  Shrink
} from 'lucide-react';
import { formatConversationTime } from '../lib/conversations';
import {
  parseResponse,
  buildSystemPrompt,
  buildDevHostPromptSection,
  getEnabledModelsForNode,
  getPreferredModelForNode,
  selectBestEndpointForTask,
  findFastestConductor,
  isFrontierNode,
  stripThinking,
  looksLikeCreateIntent,
  hasUnclosedWrite,
  anchorWritePath
} from '../lib/tools';
import {
  assignSwarmTasksToCluster,
  buildContractRepairPrompt,
  buildLeadArchitectPrompt,
  buildRepairWorkerPrompt,
  buildSwarmWorkerPrompt,
  fallbackSwarmManifest,
  findLeadArchitect,
  groupTscErrorsByFile,
  isTypeScriptContractPath,
  endpointQueueKey,
  parseSwarmManifest,
  partitionSwarmTasksIntoWaves,
  queueAssignmentsByGpu,
  shouldRejectPlannerWrite,
  type SwarmAssignment,
  type SwarmManifest
} from '../lib/swarmContract';
import {
  MAX_COMMAND_FIX_ATTEMPTS,
  autoApplyWritableTools,
  buildContinuationUserPrompt,
  collapseDuplicateReadTools,
  collectFeedbackTools,
  executeTool,
  failedCommandSignatures,
  historyForModel,
  isEmptyTerminalResult,
  isReadOnlyToolBatch,
  latestTerminalResult,
  runCommandTools,
  runAuxTools,
  runReadOnlyTools,
  shouldContinueFromTools,
  terminalResultFingerprint,
  toolContinuationLimit
} from '../lib/agentLoop';
import { streamChat } from '../lib/ollamaClient';
import { ToolActionCard } from './agent/ToolActionCard';
import { PlanOptionsCard } from './agent/PlanOptionsCard';
import { ReviewPlanCard } from './agent/ReviewPlanCard';
import { PlannerPlanPanel } from './agent/PlannerPlanPanel';
import { StepVerdictCard } from './agent/StepVerdictCard';
import { HelpTip } from './agent/HelpTip';
import { ActivityIndicator, streamingActivityLabel } from './agent/ActivityIndicator';
import { modelSupportsThinking, resolveThinkOption, thinkingToggleLabel } from '../lib/thinking';
import { resolveModelNumCtx } from '../lib/contextSize';
import {
  ASSIST_MAX_PREDICT,
  contextOverflow,
  estimateTokens,
  FREE_TIER_ASSIST_SYSTEM,
  bumpFreeTierUsage,
  isRateLimitError,
  pickFreeTierAssist,
  rateLimitBackoffMs,
  waitForFreeTierRpm,
  pickPaidFrontier,
  tailForAssist,
  type FreeTierUsage
} from '../lib/freeTierAssist';
import {
  isRepeatStop,
  nextStuckStage,
  resolveStuckStage,
  stripKeepFixingPrefix,
  stuckKey,
  type StuckStage
} from '../lib/stuckEscalation';
import { compactMessages, historyTokens, shouldCompact } from '../lib/compactChat';
import {
  advanceNext,
  avoidRepeat,
  emptyWorkLog,
  hasWorkLog,
  noteSavedFiles,
  noteUserTurn,
  parseWorkLog,
  rememberAsked,
  renderWorkLog,
  workLogPath,
  type WorkLog
} from '../lib/workLog';
import { fileToChatImage, modelSupportsVision, toOllamaBase64 } from '../lib/images';
import {
  buildApprovedPlan,
  buildPlanSummary,
  findPendingPlanMessage,
  findPlanOriginalRequest,
  formatApprovedPlanBrief,
  formatApprovedPlanContext,
  formatApprovedPlanForSwarm,
  coerceDirtyReviewPlan,
  extractFixContractBrief,
  formatReviewPlanForCoder,
  formatReviewPlanForPlanner,
  matchPlanOption,
  parseExecutionPlan,
  parsePlanOptions,
  parseReviewDelta,
  parseReviewPlan,
  parseStepVerdict,
  stripExecutionPlanMarkup,
  stripFixContractMarkup,
  stripPlanOptionMarkup,
  stripReviewDeltaMarkup,
  stripReviewPlanMarkup,
  stripStepVerdictMarkup
} from '../lib/planOptions';
import {
  applyReviewDelta,
  createQueueFromReviewPlan,
  formatActiveTaskForPlanner,
  formatQueueForReviewer,
  getActiveTask,
  hasOpenTasks,
  markInProgress,
  pickNextPending,
  queueToReviewPlan
} from '../lib/executionQueue';
import {
  activateNextStep,
  applyStepVerdict,
  createPlanFromParsed,
  formatStepForCoders,
  formatStepForReviewer,
  getActiveStep,
  isPlanActive,
  markAllStepTasks,
  markStepInProgress,
  parsePlannerPlanJson,
  plannerPlanPath,
  serializePlannerPlan
} from '../lib/plannerPlan';
import {
  buildContinuationReviewPrompt,
  buildTouchedFilesContext,
  collectWrittenPaths,
  CONTINUATION_REVIEW_SYSTEM,
  filterInspectionContinue,
  MAX_AUTO_CONTINUATIONS,
  parseNextStep,
  pickCapableReviewTarget,
  pickLargestLocalTarget,
  stripNextStepMarkup,
  taskFixesWrittenFiles,
  tasksTooSimilar
} from '../lib/continuationReview';

interface AgentChatProps {
  agents: AgentPersona[];
  selectedAgentId: string;
  onSelectAgent: (id: string) => void;
  nodes: EndpointNode[];
  activeTab?: OpenTab;
  workspacePath: string;
  workspaceFiles?: WorkspaceFile[];
  width?: number;
  /** Right orchestration column width inside the conductor */
  controlWidth?: number;
  onControlWidthChange?: (width: number) => void;
  onSelectNodeModel?: (nodeId: string, model: string) => void;
  onApplyFileWrite: (filePath: string, content: string) => Promise<boolean>;
  onExecuteToolCommand: (command: string) => Promise<string>;
  onOpenFileInEditor: (filePath: string) => void;
  onRecordTokens: (localTokens: number, frontierTokens: number) => void;
  /** Count one free-tier assist call against that node's daily cap. */
  onNoteFreeTierCall?: (nodeId: string) => void;
  /** Active chat thread (controlled by App) */
  conversation: ChatConversation | null;
  workspaceConversations: ChatConversation[];
  onMessagesChange: (messages: ChatMessage[]) => void;
  onConversationPatch?: (
    patch: Partial<
      Pick<ChatConversation, 'approvedPlan' | 'executionQueue' | 'plannerPlan' | 'agentId'>
    >
  ) => void;
  onNewChat: () => void;
  onSelectConversation: (id: string) => void;
  onDeleteConversation: (id: string) => void;
  /** Persist think on/off for a model on a node */
  onToggleModelThinking?: (nodeId: string, modelName: string, enabled: boolean) => void;
  searxngUrl?: string;
  /** Inner tool-loop budget (settings.maxAgentSteps). */
  maxAgentSteps?: number;
  /** True while a local/frontier agent turn (or stuck ladder) is in flight — blocks update restart. */
  onBusyChange?: (busy: boolean) => void;
}

export const AgentChat: React.FC<AgentChatProps> = ({
  agents,
  selectedAgentId,
  onSelectAgent,
  nodes,
  activeTab,
  workspacePath,
  workspaceFiles,
  width = 640,
  controlWidth = 270,
  onControlWidthChange,
  onSelectNodeModel,
  onApplyFileWrite,
  onExecuteToolCommand,
  onOpenFileInEditor,
  onRecordTokens,
  onNoteFreeTierCall,
  conversation,
  workspaceConversations,
  onMessagesChange,
  onConversationPatch,
  onNewChat,
  onSelectConversation,
  onDeleteConversation,
  onToggleModelThinking,
  searxngUrl = '',
  maxAgentSteps = 12,
  onBusyChange
}) => {
  const toolStepLimit = toolContinuationLimit(maxAgentSteps);
  const currentAgent = agents.find(a => a.id === selectedAgentId) || agents[0];
  const coderAgent = agents.find(a => a.handle === 'coder' || a.id === 'coder') || agents[0];
  const plannerAgent = agents.find(a => a.handle === 'planner' || a.id === 'planner') || agents[0];
  const reviewerAgent = agents.find(a => a.handle === 'reviewer' || a.id === 'reviewer') || agents[0];
  const isPlannerSelected =
    currentAgent.handle === 'planner' || currentAgent.id === 'planner';
  const isReviewerSelected =
    currentAgent.handle === 'reviewer' || currentAgent.id === 'reviewer';

  // Routing states
  const [targetNodeId, setTargetNodeId] = useState<string>(currentAgent.endpointId);
  const [targetModel, setTargetModel] = useState<string>(currentAgent.model);
  const [autoSelectEndpoint, setAutoSelectEndpoint] = useState<boolean>(true);
  const [includeActiveFile, setIncludeActiveFile] = useState(true);
  const [isPipelineMode, setIsPipelineMode] = useState(false);
  const [autoApplyWrites, setAutoApplyWrites] = useState<boolean>(currentAgent.autoApproveWrites ?? true);
  const autoApplyWritesRef = useRef(currentAgent.autoApproveWrites ?? true);
  /** After each coding step: Reviewer runs; ON = auto Send to Planner→Coder / continue, OFF = wait for user */
  const [autoReview, setAutoReview] = useState(true);
  const autoReviewRef = useRef(true);
  /** Resume depth when user approval is required after a post-step review */
  const pendingReviewResumeRef = useRef<{ depth: number; previousTask: string } | null>(null);

  const [input, setInput] = useState('');
  const [pendingImages, setPendingImages] = useState<string[]>([]);
  const [messages, setMessages] = useState<ChatMessage[]>(conversation?.messages || []);
  const [isStreaming, setIsStreaming] = useState(false);
  useEffect(() => {
    onBusyChange?.(isStreaming);
    return () => onBusyChange?.(false);
  }, [isStreaming, onBusyChange]);
  const [historyOpen, setHistoryOpen] = useState(false);
  /** Banner after user picks a plan option — Coder is running the locked plan */
  const [executingPlanNotice, setExecutingPlanNotice] = useState<string | null>(null);
  const chatBottomRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const activeAbortsRef = useRef<(() => void)[]>([]);
  const messagesRef = useRef<ChatMessage[]>([]);
  const continuationDepthRef = useRef(0);
  const commandFixAttemptsRef = useRef(0);
  const writeFixAttemptsRef = useRef(0);
  const prevFailedCmdSigsRef = useRef<string[]>([]);
  const conversationIdRef = useRef<string | null>(conversation?.id ?? null);
  const approvedPlanRef = useRef<ApprovedPlan | null>(conversation?.approvedPlan ?? null);
  const executionQueueRef = useRef<ExecutionQueue | null>(conversation?.executionQueue ?? null);
  const plannerPlanRef = useRef<PlannerPlan | null>(conversation?.plannerPlan ?? null);
  const [plannerPlanView, setPlannerPlanView] = useState<PlannerPlan | null>(
    conversation?.plannerPlan ?? null
  );
  const stopRequestedRef = useRef(false);

  const commitExecutionQueue = (next: ExecutionQueue | null) => {
    executionQueueRef.current = next;
    onConversationPatch?.({ executionQueue: next });
  };

  const commitPlannerPlan = (next: PlannerPlan | null) => {
    plannerPlanRef.current = next;
    setPlannerPlanView(next);
    onConversationPatch?.({ plannerPlan: next });
    const id = conversationIdRef.current;
    if (!workspacePath || !id || !window.electronAPI?.writeFile) return;
    if (next) {
      void window.electronAPI.writeFile(
        plannerPlanPath(workspacePath, id),
        serializePlannerPlan(next)
      );
    }
  };
  const freeTierUsageRef = useRef<Record<string, FreeTierUsage>>({});
  const stuckRef = useRef<{ key: string; stage: StuckStage }>({ key: '', stage: 'none' });

  type LoopBudget = {
    depth: number;
    commandFixAttempts: number;
    prevFailedCmdSigs: string[];
    writeFixAttempts: number;
    readOnlyContinues: number;
    terminalFingerprint?: string;
  };

  const readOnlyContinuesRef = useRef(0);
  const terminalFingerprintRef = useRef<string | undefined>(undefined);

  const resetAgentLoopBudget = () => {
    continuationDepthRef.current = 0;
    commandFixAttemptsRef.current = 0;
    writeFixAttemptsRef.current = 0;
    prevFailedCmdSigsRef.current = [];
    readOnlyContinuesRef.current = 0;
    terminalFingerprintRef.current = undefined;
  };

  const continueDecisionOpts = (
    budget?: LoopBudget,
    extra?: { maxReadOnlyContinues?: number }
  ) => ({
    commandFixAttempts: budget ? budget.commandFixAttempts : commandFixAttemptsRef.current,
    prevFailedCmdSigs: budget ? budget.prevFailedCmdSigs : prevFailedCmdSigsRef.current,
    writeFixAttempts: budget ? budget.writeFixAttempts : writeFixAttemptsRef.current,
    readOnlyContinues: budget ? budget.readOnlyContinues : readOnlyContinuesRef.current,
    terminalFingerprint: budget
      ? budget.terminalFingerprint
      : terminalFingerprintRef.current,
    ...(extra?.maxReadOnlyContinues != null
      ? { maxReadOnlyContinues: extra.maxReadOnlyContinues }
      : {})
  });

  const rememberTerminalFingerprint = (tools: ToolCall[], budget?: LoopBudget) => {
    const result = latestTerminalResult(tools);
    if (!result) return;
    const fp = terminalResultFingerprint(result);
    if (!fp) return;
    if (budget) budget.terminalFingerprint = fp;
    else terminalFingerprintRef.current = fp;
  };

  const skipPersistRef = useRef(false);

  // Sync local message buffer when App switches conversations
  useEffect(() => {
    const nextId = conversation?.id ?? null;
    if (nextId !== conversationIdRef.current) {
      activeAbortsRef.current.forEach(abort => abort());
      activeAbortsRef.current = [];
      setIsStreaming(false);
      resetAgentLoopBudget();
      conversationIdRef.current = nextId;
      const nextMsgs = conversation?.messages || [];
      skipPersistRef.current = true;
      setMessages(nextMsgs);
      messagesRef.current = nextMsgs;
      approvedPlanRef.current = conversation?.approvedPlan ?? null;
      executionQueueRef.current = conversation?.executionQueue ?? null;
      plannerPlanRef.current = conversation?.plannerPlan ?? null;
      setPlannerPlanView(conversation?.plannerPlan ?? null);
      setExecutingPlanNotice(null);
      setInput('');
      setPendingImages([]);
      setHistoryOpen(false);
      stuckRef.current = { key: '', stage: 'none' };
      // File-backed plan survives compaction
      const root = workspacePath;
      const cid = nextId;
      if (root && cid && window.electronAPI?.readFile) {
        void window.electronAPI.readFile(plannerPlanPath(root, cid)).then(res => {
          if (conversationIdRef.current !== cid) return;
          const fromDisk = res.content ? parsePlannerPlanJson(res.content) : null;
          if (fromDisk && (!conversation?.plannerPlan || fromDisk.updatedAt >= (conversation.plannerPlan.updatedAt || 0))) {
            plannerPlanRef.current = fromDisk;
            setPlannerPlanView(fromDisk);
            onConversationPatch?.({ plannerPlan: fromDisk });
          }
        });
      }
    }
  }, [conversation?.id]);

  useEffect(() => {
    if (conversation?.id === conversationIdRef.current) {
      approvedPlanRef.current = conversation?.approvedPlan ?? null;
    }
  }, [conversation?.approvedPlan, conversation?.id]);

  useEffect(() => {
    if (conversation?.id === conversationIdRef.current) {
      executionQueueRef.current = conversation?.executionQueue ?? null;
    }
  }, [conversation?.executionQueue, conversation?.id]);

  useEffect(() => {
    if (conversation?.id === conversationIdRef.current && conversation?.plannerPlan) {
      plannerPlanRef.current = conversation.plannerPlan;
      setPlannerPlanView(conversation.plannerPlan);
    }
  }, [conversation?.plannerPlan, conversation?.id]);

  const progressRef = useRef<WorkLog>(emptyWorkLog());
  const progressRev = useRef(0);
  const [progressLog, setProgressLog] = useState<WorkLog>(emptyWorkLog());

  const commitProgress = (next: WorkLog) => {
    progressRev.current += 1;
    progressRef.current = next;
    setProgressLog(next);
    const id = conversationIdRef.current;
    if (!workspacePath || !id || !window.electronAPI?.writeFile) return;
    void window.electronAPI.writeFile(workLogPath(workspacePath, id), renderWorkLog(next));
  };

  const updateProgress = (fn: (log: WorkLog) => WorkLog) => {
    commitProgress(fn(progressRef.current));
  };

  useEffect(() => {
    const id = conversation?.id;
    const root = workspacePath;
    if (!id || !root || !window.electronAPI?.readFile) {
      progressRef.current = emptyWorkLog();
      setProgressLog(emptyWorkLog());
      return;
    }
    const rev = progressRev.current;
    let cancel = false;
    window.electronAPI.readFile(workLogPath(root, id)).then(res => {
      if (cancel || progressRev.current !== rev || conversationIdRef.current !== id) return;
      const log = res.content ? parseWorkLog(res.content) : emptyWorkLog();
      progressRef.current = log;
      setProgressLog(log);
    });
    return () => {
      cancel = true;
    };
  }, [conversation?.id, workspacePath]);

  // Persist message edits up to App (skip one tick after conversation switch)
  useEffect(() => {
    if (skipPersistRef.current) {
      skipPersistRef.current = false;
      return;
    }
    if (!conversation?.id || conversationIdRef.current !== conversation.id) return;
    onMessagesChange(messages);
  }, [messages]);

  // Workspace file tree summary for prompt injection
  const workspaceOverview = (workspaceFiles && workspaceFiles.length > 0)
    ? workspaceFiles.slice(0, 80).map(f => (f.isDirectory ? `📁 ${f.name}/` : `📄 ${f.name}`)).join('\n')
    : '(empty workspace or loading)';

  const toolDeps = {
    workspacePath,
    onApplyFileWrite,
    onExecuteToolCommand,
    nodes,
    searxngUrl
  };

  // Sync permissions when the persona changes. Do not stamp the persona's
  // default model onto a node where that model is disabled or not installed.
  useEffect(() => {
    if (currentAgent.endpointId && nodes.some(n => n.id === currentAgent.endpointId)) {
      setTargetNodeId(currentAgent.endpointId);
    }
    if (currentAgent.autoApproveWrites !== undefined) {
      autoApplyWritesRef.current = currentAgent.autoApproveWrites;
      setAutoApplyWrites(currentAgent.autoApproveWrites);
    }
  }, [currentAgent.id, currentAgent.endpointId, currentAgent.autoApproveWrites]);

  // Selected node with fallback to online node if offline (undefined when cluster is empty)
  const requestedNode = nodes.find(n => n.id === targetNodeId) || nodes[0];
  const onlineLocalNodes = nodes.filter(
    n => n.online && n.type !== 'openai' && getEnabledModelsForNode(n).length > 0
  );
  const selectedNode =
    requestedNode &&
    requestedNode.online &&
    getEnabledModelsForNode(requestedNode).length > 0
      ? requestedNode
      : onlineLocalNodes[0] || requestedNode;

  const isFrontier = selectedNode?.type === 'openai' || !!selectedNode?.apiKey;

  // Enabled models on selected node (live catalog when online — never invent deleted models)
  const availableModels = getEnabledModelsForNode(selectedNode);
  const effectiveModels =
    availableModels.length > 0
      ? availableModels
      : isFrontier && !selectedNode?.online
        ? ['grok-2-1212', 'grok-beta', 'gpt-4o', 'claude-3-5-sonnet']
        : [];

  useEffect(() => {
    if (effectiveModels.length === 0) return;
    const preferred = getPreferredModelForNode(selectedNode, targetModel);
    if (!effectiveModels.includes(targetModel)) {
      setTargetModel(preferred);
    } else if (selectedNode?.activeModel && effectiveModels.includes(selectedNode.activeModel) && targetModel !== selectedNode.activeModel) {
      setTargetModel(selectedNode.activeModel);
    }
  }, [selectedNode?.id, selectedNode?.activeModel, effectiveModels.join(',')]);

  useEffect(() => {
    messagesRef.current = messages;
  }, [messages]);

  useEffect(() => {
    chatBottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, isStreaming]);

  // Persona defaults (qwen2.5-coder:7b, etc.) are only a hint. The label and the
  // request use a model that is actually enabled on the selected node.
  const activeTargetModel = effectiveModels.includes(targetModel)
    ? targetModel
    : (getPreferredModelForNode(selectedNode, currentAgent.model) || effectiveModels[0] || '');

  const benchmarkStat = selectedNode?.benchmarks?.[activeTargetModel];
  const selectedModelInfo =
    selectedNode?.models?.find(m => m.name === activeTargetModel) ||
    (selectedNode?.modelMeta?.[activeTargetModel]
      ? {
          name: activeTargetModel,
          capabilities: selectedNode.modelMeta[activeTargetModel].capabilities,
          thinking: selectedNode.modelMeta[activeTargetModel].thinking
        }
      : undefined);
  const selectedSupportsThink = modelSupportsThinking(selectedModelInfo);
  const selectedThinkPref = selectedNode?.modelPrefs?.[activeTargetModel]?.think;
  const selectedThinkOn =
    selectedThinkPref === true ||
    selectedThinkPref === 'true' ||
    (typeof selectedThinkPref === 'string' && selectedThinkPref !== 'false');
  const selectedSupportsVision = modelSupportsVision(
    activeTargetModel,
    selectedNode,
    selectedNode?.models?.find(m => m.name === activeTargetModel)
  );

  const addImageFiles = async (files: FileList | File[] | null) => {
    if (!files) return;
    const list = Array.from(files).filter(f => f.type.startsWith('image/'));
    if (!list.length) return;
    const encoded: string[] = [];
    for (const f of list.slice(0, 4)) {
      try {
        encoded.push(await fileToChatImage(f));
      } catch (err) {
        console.warn('Failed to attach image', err);
      }
    }
    if (encoded.length) {
      setPendingImages(prev => [...prev, ...encoded].slice(0, 6));
    }
  };

  const handlePaste = async (e: React.ClipboardEvent) => {
    const items = e.clipboardData?.items;
    if (!items) return;
    const imageFiles: File[] = [];
    for (const item of Array.from(items)) {
      if (item.type.startsWith('image/')) {
        const file = item.getAsFile();
        if (file) imageFiles.push(file);
      }
    }
    if (!imageFiles.length) return;
    e.preventDefault();
    await addImageFiles(imageFiles);
  };

  /** Attach top-level Ollama `think` when the selected model supports it. */
  const withThink = (body: Record<string, unknown>, node: EndpointNode | undefined, model: string) => {
    const live = node?.models?.find(m => m.name === model);
    const meta = node?.modelMeta?.[model];
    const modelInfo = live || (meta
      ? { name: model, capabilities: meta.capabilities, thinking: meta.thinking }
      : undefined);
    const think = resolveThinkOption(modelInfo, node?.modelPrefs?.[model]?.think);
    if (think === undefined) return body;
    return { ...body, think };
  };

  /** Per-model num_ctx from Hardware Settings; falls back to agent persona. */
  const chatNumCtx = (node: EndpointNode | undefined, model: string) =>
    resolveModelNumCtx(node, model, currentAgent.numCtx);

  const freeTierUsageFor = (node: EndpointNode): FreeTierUsage | undefined => {
    const saved = node.freeTierUsage;
    const local = freeTierUsageRef.current[node.id];
    if (!saved) return local;
    if (!local) return saved;
    if (saved.day !== local.day) return saved.day > local.day ? saved : local;
    return (saved.count || 0) >= (local.count || 0) ? saved : local;
  };

  /** One short frontier reply. Free-tier calls pace to RPM and count against the daily cap. */
  const requestAssistBrief = async (
    target: { node: EndpointNode; model: string },
    purpose: string,
    payload: string,
    countFreeTier: boolean
  ): Promise<string | null> => {
    if (stopRequestedRef.current) return null;

    const runOnce = async (): Promise<{ content: string; aborted: boolean; stats?: { evalCount?: number; promptEvalCount?: number }; error?: string }> => {
      if (countFreeTier) {
        const waited = await waitForFreeTierRpm(target.node, {
          signal: stopRequestedRef.current ? { aborted: true } : undefined,
          onWait: ms => {
            setExecutingPlanNotice(
              `Free-tier RPM limit — waiting ${Math.ceil(ms / 1000)}s before assist on ${target.node.name}…`
            );
          }
        });
        if (stopRequestedRef.current) return { content: '', aborted: true };
        if (waited > 0) {
          window.electronAPI?.writeLog?.(
            'info',
            `free-tier RPM wait ${waited}ms on ${target.node.name}`
          );
        }
      }
      const handle = streamChat(
        target.node.url,
        withThink(
          {
            model: target.model,
            messages: [
              { role: 'system', content: FREE_TIER_ASSIST_SYSTEM },
              { role: 'user', content: `${purpose}\n\n${tailForAssist(payload)}` }
            ],
            options: { temperature: 0.1, num_predict: ASSIST_MAX_PREDICT }
          },
          target.node,
          target.model
        ),
        () => {},
        target.node.type,
        target.node.apiKey
      );
      activeAbortsRef.current = [...activeAbortsRef.current, handle.abort];
      try {
        const result = await handle.done;
        return {
          content: result.content || '',
          aborted: result.aborted,
          stats: result.stats
        };
      } catch (err: any) {
        return { content: '', aborted: false, error: err?.message || String(err) };
      }
    };

    let result = await runOnce();
    // If the stream layer still surfaces a rate-limit error, wait and retry once more.
    for (let attempt = 0; attempt < 2; attempt++) {
      if (result.aborted || stopRequestedRef.current) return null;
      if (!isRateLimitError(result.error) && result.content.trim()) break;
      if (!isRateLimitError(result.error) && !result.error) break;
      if (!isRateLimitError(result.error)) break;
      const backoff = rateLimitBackoffMs(result.error, attempt);
      setExecutingPlanNotice(
        `Free-tier rate limit — waiting ${Math.ceil(backoff / 1000)}s then retrying assist…`
      );
      window.electronAPI?.writeLog?.(
        'warn',
        `free-tier rate limit retry in ${backoff}ms: ${result.error}`
      );
      await new Promise<void>(r => setTimeout(r, backoff));
      if (stopRequestedRef.current) return null;
      result = await runOnce();
    }

    if (result.aborted || stopRequestedRef.current) return null;
    if (result.error && !result.content.trim()) {
      window.electronAPI?.writeLog?.('warn', `free-tier assist failed: ${result.error}`);
      return null;
    }
    const brief = (result.content || '').replace(/\s+/g, ' ').trim().slice(0, 1800);
    if (!brief) return null;
    if (countFreeTier) {
      freeTierUsageRef.current[target.node.id] = bumpFreeTierUsage(freeTierUsageFor(target.node));
      onNoteFreeTierCall?.(target.node.id);
    }
    if (result.stats?.evalCount) {
      onRecordTokens(0, result.stats.evalCount + (result.stats.promptEvalCount || 0));
    }
    return brief;
  };

  /** One short frontier reply when the local window cannot hold the job. Null when no free-tier quota is left. */
  const requestFreeTierBrief = async (purpose: string, payload: string): Promise<string | null> => {
    const assist = pickFreeTierAssist(nodes, freeTierUsageFor);
    if (!assist) return null;
    return requestAssistBrief(assist, purpose, payload, true);
  };

  const progressForPrompt = () => (hasWorkLog(progressRef.current) ? renderWorkLog(progressRef.current) : '');

  const fitContext = (numCtx: number, force = false) => {
    const current = messagesRef.current;
    if (current.length < 6) return;
    if (!force && !shouldCompact(current, numCtx)) return;
    const next = compactMessages(current);
    if (next.length >= current.length && historyTokens(next) >= historyTokens(current) * 0.9) return;
    messagesRef.current = next;
    setMessages(next);
  };

  /** One extra request when a model stops inside an open write tag, then the file can be saved. */
  const finishTruncatedWrites = async (
    node: EndpointNode,
    model: string,
    content: string,
    doneReason?: string
  ): Promise<string> => {
    const open = hasUnclosedWrite(content);
    if (!open || stopRequestedRef.current) return content;
    // A clean stop just forgot the closing tag — save the body as-is.
    // Keep going only when the API cut the reply off.
    if (/^(stop|end_turn|end)$/i.test(doneReason || '')) return content;
    const body = withThink(
      {
        model,
        messages: [
          {
            role: 'system',
            content:
              'A file write was cut off. Continue from the exact cutoff. Output only the missing remainder of that file, then a closing </' +
              open.name +
              '> tag. Do not repeat text already written. Do not open a new file tag.'
          },
          { role: 'assistant', content: content.slice(-6000) },
          {
            role: 'user',
            content:
              'Continue the unfinished <' +
              open.name +
              ' path="' +
              open.path +
              '"> from the last characters above. End with </' +
              open.name +
              '>.'
          }
        ],
        options: { temperature: 0.2, num_ctx: chatNumCtx(node, model) }
      },
      node,
      model
    );
    try {
      const handle = streamChat(node.url, body, () => {}, node.type, node.apiKey);
      activeAbortsRef.current.push(handle.abort);
      const res = await handle.done;
      const extra = (res.content || '').trim();
      if (!extra) return content;
      return content + (content.endsWith('\n') ? '' : '\n') + extra;
    } catch (err: any) {
      window.electronAPI?.writeLog?.('error', `finish truncated write: ${err?.message || err}`);
      return content;
    }
  };

  // ==========================================
  // UNIFIED TOOL EXECUTION & AGENTIC LOOP
  // ==========================================
  const runSingleTool = async (tool: ToolCall): Promise<ToolCall> => {
    const updated = await executeTool(tool, toolDeps);
    updateProgress(log => noteSavedFiles(log, [updated]));
    let hostMsg: ChatMessage | undefined;
    setMessages(prev =>
      prev.map(m => {
        if (!m.toolCalls?.some(t => t.id === tool.id)) return m;
        const next = {
          ...m,
          toolCalls: m.toolCalls!.map(t => (t.id === tool.id ? updated : t))
        };
        hostMsg = next;
        return next;
      })
    );
    // Manual Run on a failed command → one self-correct attempt
    if (
      updated.name === 'run_command' &&
      updated.status === 'error' &&
      hostMsg &&
      shouldContinueFromTools(hostMsg.toolCalls || [], continueDecisionOpts())
    ) {
      resetAgentLoopBudget();
      await continueWithToolResults(hostMsg, { createIntent: true });
    }
    return updated;
  };

  const continueWithToolResults = async (
    originMsg: ChatMessage,
    opts?: {
      expectedFilePath?: string;
      createIntent?: boolean;
      node?: EndpointNode;
      model?: string;
      budget?: LoopBudget;
      /** Explicit role for this continue — never infer from stale UI currentAgent. */
      role?: 'planner' | 'reviewer' | 'coder' | 'docs';
      stepVerdictMode?: boolean;
      lockPlanMode?: boolean;
      reviewMode?: boolean;
    }
  ) => {
    const budget = opts?.budget;
    const depth = budget ? budget.depth : continuationDepthRef.current;
    if (depth >= toolStepLimit) return;

    const feedbackTools = collectFeedbackTools(originMsg.toolCalls || []);
    if (feedbackTools.length === 0) return;

    // Role from the originating turn only. currentAgent is often still Planner after
    // onSelectAgent(coder) because React state has not re-rendered yet — that wrongly
    // re-opened <plan_options> mid-execution in Webtest.
    const originRole = (
      opts?.role ||
      originMsg.personaHandle ||
      'coder'
    ).toLowerCase();
    const planLocked = isPlanActive(plannerPlanRef.current);
    const reviewModeContinue =
      !!opts?.reviewMode || originRole === 'reviewer' || !!opts?.stepVerdictMode;
    // Architecture <plan_options> only before a plan is locked — never mid-execution.
    const planModeContinue =
      originRole === 'planner' &&
      !planLocked &&
      !opts?.lockPlanMode &&
      !reviewModeContinue;
    const lockPlanContinue = !!opts?.lockPlanMode || (originRole === 'planner' && planLocked);
    const reviewModeGate = reviewModeContinue;
    const continueOpts = continueDecisionOpts(budget, {
      maxReadOnlyContinues: reviewModeGate ? 1 : undefined
    });
    const prevTerminalFp = continueOpts.terminalFingerprint;
    if (!shouldContinueFromTools(originMsg.toolCalls || [], continueOpts)) {
      rememberTerminalFingerprint(originMsg.toolCalls || [], budget);
      return;
    }

    const cmdFailed = feedbackTools.some(t => t.name === 'run_command' && t.status === 'error');
    const writeFailed = feedbackTools.some(
      t => (t.name === 'write_file' || t.name === 'edit_file') && t.status === 'error'
    );
    const priorFixAttempts = budget ? budget.commandFixAttempts : commandFixAttemptsRef.current;
    if (cmdFailed) {
      const sigs = failedCommandSignatures(feedbackTools);
      if (budget) {
        budget.prevFailedCmdSigs = [...new Set([...budget.prevFailedCmdSigs, ...sigs])];
        budget.commandFixAttempts += 1;
      } else {
        prevFailedCmdSigsRef.current = [
          ...new Set([...prevFailedCmdSigsRef.current, ...sigs])
        ];
        commandFixAttemptsRef.current += 1;
      }
    }
    if (writeFailed) {
      if (budget) budget.writeFixAttempts += 1;
      else writeFixAttemptsRef.current += 1;
    }
    if (isReadOnlyToolBatch(originMsg.toolCalls || [])) {
      if (budget) budget.readOnlyContinues += 1;
      else readOnlyContinuesRef.current += 1;
    }

    if (budget) budget.depth += 1;
    else continuationDepthRef.current += 1;

    const currentTerminalFp = (() => {
      const result = latestTerminalResult(originMsg.toolCalls || []);
      return result ? terminalResultFingerprint(result) : undefined;
    })();
    const sameTerminalFingerprint = Boolean(
      prevTerminalFp && currentTerminalFp && prevTerminalFp === currentTerminalFp
    );
    rememberTerminalFingerprint(originMsg.toolCalls || [], budget);
    const routeNode = opts?.node || selectedNode;
    if (!routeNode) return;
    const routeModel = opts?.model || activeTargetModel;
    const followUpId = `followup-${Date.now()}`;
    const continueAgent = reviewModeContinue
      ? reviewerAgent
      : planModeContinue || lockPlanContinue
        ? plannerAgent
        : coderAgent;
    const followUpMsg: ChatMessage = {
      id: followUpId,
      role: 'assistant',
      raw: '',
      display: cmdFailed
        ? 'Command failed — one fix attempt from terminal output...'
        : planModeContinue
          ? 'Explored the workspace. Drafting the plan and options...'
          : lockPlanContinue
            ? 'Explored the workspace. Locking execution steps...'
          : reviewModeContinue
            ? 'Explored the workspace. Drafting the review fix plan...'
            : 'Analyzed project files. Now generating implementation...',
      agentId: continueAgent.id,
      personaHandle: continueAgent.handle || originRole,
      endpointId: routeNode.id,
      endpointName: routeNode.name,
      model: routeModel,
      timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
      toolCalls: []
    };

    setMessages(prev => [...prev, followUpMsg]);
    setIsStreaming(true);

    try {
      let continuationPrompt = buildContinuationUserPrompt(feedbackTools, {
        // True only on a 2nd+ command-fix continue (when MAX_COMMAND_FIX_ATTEMPTS > 1)
        finalCommandAttempt: priorFixAttempts > 0
      });
      const emptyTerminalNoFail =
        feedbackTools.some(
          t => t.name === 'read_terminal' && t.status === 'done' && isEmptyTerminalResult(t.result)
        ) && !feedbackTools.some(t => t.name === 'run_command' && t.status === 'error');
      if (emptyTerminalNoFail) {
        continuationPrompt +=
          '\n\n[DIRECTIVE: Terminal buffer is empty. Do NOT call <read_terminal> again.]';
      } else if (sameTerminalFingerprint) {
        continuationPrompt +=
          '\n\n[DIRECTIVE: Do NOT call read_terminal again; terminal output is unchanged.]';
      }
      const readOnlyContinue =
        planModeContinue || reviewModeContinue || lockPlanContinue;
      const stepVerdictContinue = !!opts?.stepVerdictMode || originMsg.stepVerdict != null;
      fitContext(chatNumCtx(routeNode, routeModel));
      const systemPrompt = buildSystemPrompt(continueAgent, workspacePath, workspaceOverview, {
        planMode: planModeContinue,
        reviewMode: reviewModeContinue,
        lockPlanMode: lockPlanContinue && !reviewModeContinue,
        stepVerdictMode: stepVerdictContinue || (planLocked && reviewModeContinue),
        approvedPlan:
          planModeContinue || reviewModeContinue || lockPlanContinue
            ? null
            : approvedPlanRef.current,
        progressLog: progressForPrompt(),
        nodes,
        inferenceNodeId: routeNode.id
      });
      const snap = messagesRef.current;
      const conversationPayload = [
        { role: 'system', content: systemPrompt },
        ...historyForModel(snap.filter(m => m.id !== followUpId), stripThinking),
        {
          role: 'assistant',
          content: stripThinking(originMsg.raw || 'I inspected the project / terminal.')
        },
        {
          role: 'user',
          content: planModeContinue
            ? `${continuationPrompt}\n\n[PLANNER DIRECTIVE: After using exploration results, produce the plan and end with a <plan_options> block. Do NOT write deliverable files.]`
            : lockPlanContinue && !reviewModeContinue
              ? `${continuationPrompt}\n\n[PLANNER DIRECTIVE: Finish the <execution_plan> steps/tasks for the chosen option. Do NOT emit <plan_options>. Do NOT write deliverable files.]`
            : reviewModeContinue
              ? stepVerdictContinue || planLocked
                ? `${continuationPrompt}\n\n[REVIEWER DIRECTIVE: STOP reading. Emit <step_verdict> yay or nay for the active step only. Do NOT emit <plan_options> or <review_plan>. Do NOT write files.]`
                : `${continuationPrompt}\n\n[REVIEWER DIRECTIVE: STOP reading more files. Report findings and end with a <review_plan> that has <task> items for Planner→Coder. Do NOT write/edit/Apply files yourself.]`
              : continuationPrompt
        }
      ];

      const body = withThink({
        model: routeModel,
        messages: conversationPayload,
        options: {
          temperature: continueAgent.temperature,
          num_ctx: chatNumCtx(routeNode, routeModel)
        }
      }, routeNode, routeModel);

      const handle = streamChat(
        routeNode.url,
        body,
        (content, thinking) => {
          const parsed = parseResponse(content, followUpId, true, {
            expectedFilePath: opts?.expectedFilePath,
            createIntent: opts?.createIntent
          });
          const liveOptions =
            planModeContinue && !isPlanActive(plannerPlanRef.current)
              ? parsePlanOptions(content)
              : [];
          const liveReview = reviewModeContinue ? parseReviewPlan(content) : null;
          const displayLive = reviewModeContinue
            ? stripReviewDeltaMarkup(
                stripReviewPlanMarkup(stripPlanOptionMarkup(parsed.display || content))
              )
            : stripPlanOptionMarkup(parsed.display || content);
          setMessages(prev => prev.map(m => {
            if (m.id === followUpId) {
              return {
                ...m,
                raw: content,
                display: displayLive,
                thinking: parsed.thinking || thinking,
                toolCalls: collapseDuplicateReadTools(
                  readOnlyContinue
                    ? parsed.toolCalls.filter(t =>
                        ['read_file', 'list_dir', 'search', 'read_terminal'].includes(t.name)
                      )
                    : parsed.toolCalls
                ),
                ...(liveOptions.length >= 2
                  ? {
                      planOptions: liveOptions,
                      planSummary: buildPlanSummary(content, liveOptions)
                    }
                  : {}),
                ...(liveReview ? { reviewPlan: liveReview } : {})
              };
            }
            return m;
          }));
        },
        routeNode.type,
        routeNode.apiKey
      );

      activeAbortsRef.current = [handle.abort];
      const result = await handle.done;
      const finished = readOnlyContinue
        ? result.content
        : await finishTruncatedWrites(routeNode, routeModel, result.content, result.stats?.doneReason);
      let finalParsed = parseResponse(finished, followUpId, false, {
        expectedFilePath: opts?.expectedFilePath,
        createIntent: readOnlyContinue ? false : (opts?.createIntent ?? true)
      });

      let tools = collapseDuplicateReadTools(finalParsed.toolCalls);
      if (readOnlyContinue) {
        tools = tools.filter(t =>
          ['read_file', 'list_dir', 'search', 'read_terminal'].includes(t.name)
        );
      }
      const readPass = await runReadOnlyTools(tools, toolDeps);
      tools = readPass.tools;

      if (!readOnlyContinue && autoApplyWritesRef.current) {
        tools = await autoApplyWritableTools(tools, toolDeps);
        tools = await runAuxTools(tools, toolDeps);
        const cmdPass = await runCommandTools(tools, toolDeps);
        tools = cmdPass.tools;
        updateProgress(log => noteSavedFiles(log, tools));
      }

      const stillFailing =
        failedCommandSignatures(tools).length > 0 &&
        !shouldContinueFromTools(tools, continueDecisionOpts(budget));
      const planOptions =
        planModeContinue && !isPlanActive(plannerPlanRef.current)
          ? parsePlanOptions(finished)
          : [];
      const reviewPlan = reviewModeContinue ? parseReviewPlan(finished) : null;
      const displayBase = reviewModeContinue
        ? stripReviewDeltaMarkup(
            stripReviewPlanMarkup(stripPlanOptionMarkup(finalParsed.display || finished))
          )
        : stripPlanOptionMarkup(finalParsed.display || finished);
      const followUpMsgFinal: ChatMessage = {
        ...followUpMsg,
        raw: finished,
        display: stillFailing
          ? `${displayBase}\n\n⚠️ Still failing after one auto-fix attempt — check the terminal, or ask to try again.`
          : displayBase,
        thinking: finalParsed.thinking || result.thinking,
        toolCalls: tools,
        ...(planOptions.length > 0
          ? {
              planOptions,
              planSummary: buildPlanSummary(finished, planOptions)
            }
          : {}),
        ...(reviewPlan ? { reviewPlan } : {})
      };

      setMessages(prev => prev.map(m => (m.id === followUpId ? followUpMsgFinal : m)));

      if (shouldContinueFromTools(tools, continueDecisionOpts(budget))) {
        await continueWithToolResults(followUpMsgFinal, opts);
      }
    } catch (err: any) {
      window.electronAPI?.writeLog?.('error', `code generation: ${err?.message || err}`);
      setMessages(prev => prev.map(m => {
        if (m.id === followUpId) {
          return {
            ...m,
            display: m.display + `\n\n⚠️ Error during code generation: ${err.message}`
          };
        }
        return m;
      }));
    } finally {
      setIsStreaming(false);
      activeAbortsRef.current = [];
    }
  };

  // ==========================================
  // CONDUCTOR SWARM — CONTRACT-FIRST TWO-PASS
  // ==========================================
  const handleSendPipelineMessage = async (
    userText: string,
    fullPrompt: string,
    opts?: { approvedPlan?: ApprovedPlan | null; skipUserAppend?: boolean }
  ) => {
    resetAgentLoopBudget();
    fitContext(chatNumCtx(selectedNode, activeTargetModel));
    const lockedPlan = opts?.approvedPlan ?? approvedPlanRef.current;
    const userMsg: ChatMessage = {
      id: `msg-${Date.now()}`,
      role: 'user',
      raw: userText,
      display: userText,
      timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
      personaHandle: 'coder'
    };

    const agentMsgId = `pipeline-${Date.now()}`;
    const architect = findLeadArchitect(nodes);

    const patchPipelineMsg = (
      patch: Partial<ChatMessage> | ((m: ChatMessage) => ChatMessage)
    ) => {
      setMessages(prev =>
        prev.map(m => {
          if (m.id !== agentMsgId) return m;
          return typeof patch === 'function' ? patch(m) : { ...m, ...patch };
        })
      );
    };

    const readWorkspaceRel = async (rel: string): Promise<string | undefined> => {
      if (!window.electronAPI || !workspacePath) return undefined;
      const abs = `${workspacePath}\\${rel.replace(/^[\\/]+/, '').replace(/\//g, '\\')}`;
      try {
        const res = await window.electronAPI.readFile(abs);
        return res.content;
      } catch {
        return undefined;
      }
    };

    const loadExistingSnippets = async (): Promise<string> => {
      if (!workspaceFiles?.length || !window.electronAPI) return '';
      const files = workspaceFiles
        .filter(f => !f.isDirectory && /\.(ts|tsx|js|jsx|json)$/i.test(f.name))
        .slice(0, 5);
      const chunks: string[] = [];
      for (const f of files) {
        try {
          const res = await window.electronAPI.readFile(f.path);
          if (res.content != null) {
            chunks.push(`### ${f.name}\n\`\`\`\n${res.content.slice(0, 2500)}\n\`\`\``);
          }
        } catch {
          /* skip */
        }
      }
      return chunks.join('\n\n');
    };

    const recordTok = (node: EndpointNode, stats?: { evalCount?: number; promptEvalCount?: number }) => {
      if (!stats?.evalCount) return;
      const tok = stats.evalCount + (stats.promptEvalCount || 0);
      if (isFrontierNode(node)) onRecordTokens(0, tok);
      else onRecordTokens(tok, 0);
    };

    const runWorkerTurn = async (opts: {
      idx: number;
      assignment: SwarmAssignment;
      userPrompt: string;
      expectedFilePath: string;
      stepLabel?: string;
      retriedFrom?: string;
    }) => {
      const { idx, assignment, userPrompt, expectedFilePath } = opts;
      const { node, model, skippedReason } = assignment;
      if (skippedReason && !node.online) {
        patchPipelineMsg(m => {
          if (!m.pipelineSteps) return m;
          const updatedSteps = [...m.pipelineSteps];
          if (updatedSteps[idx]) {
            updatedSteps[idx] = {
              ...updatedSteps[idx],
              status: 'failed',
              content: `Skipped: ${skippedReason}`
            };
          }
          return { ...m, pipelineSteps: updatedSteps };
        });
        return;
      }

      const workerSystemPrompt = buildSystemPrompt(currentAgent, workspacePath, workspaceOverview, {
        progressLog: progressForPrompt(),
        nodes,
        inferenceNodeId: node.id
      });
      const body = withThink(
        {
          model,
          messages: [
            { role: 'system', content: workerSystemPrompt },
            { role: 'user', content: userPrompt }
          ],
          options: { temperature: currentAgent.temperature, num_ctx: chatNumCtx(node, model) }
        },
        node,
        model
      );

      try {
        const handle = streamChat(
          node.url,
          body,
          content => {
            patchPipelineMsg(m => {
              if (!m.pipelineSteps) return m;
              const updatedSteps = [...m.pipelineSteps];
              if (updatedSteps[idx]) {
                updatedSteps[idx] = { ...updatedSteps[idx], content };
              }
              return { ...m, pipelineSteps: updatedSteps };
            });
          },
          node.type,
          node.apiKey
        );
        activeAbortsRef.current.push(handle.abort);
        const res = await handle.done;
        recordTok(node, res.stats);
        const finished = await finishTruncatedWrites(node, model, res.content, res.stats?.doneReason);

        let tools = parseResponse(finished, `${agentMsgId}-${idx}`, false, {
          expectedFilePath,
          createIntent: true
        }).toolCalls.map(t => anchorWritePath(t, expectedFilePath));

        tools = tools.map(t => {
          if (
            (t.name === 'write_file' || t.name === 'edit_file') &&
            shouldRejectPlannerWrite(t.args?.path || expectedFilePath || '', t.body || '')
          ) {
            return {
              ...t,
              status: 'error' as const,
              result:
                'Rejected: body looks like planner/option prose, not source for this path. Rewrite with real file contents only.'
            };
          }
          return t;
        });

        const readPass = await runReadOnlyTools(tools, toolDeps);
        tools = readPass.tools;

        // Node results are the files. Always save them, including when this turn
        // started under the planner (Auto-apply still off in that closure).
        tools = await autoApplyWritableTools(tools, toolDeps);
        updateProgress(log => noteSavedFiles(log, tools));
        if (autoApplyWritesRef.current) {
          tools = await runAuxTools(tools, toolDeps);
          const cmdPass = await runCommandTools(tools, toolDeps);
          tools = cmdPass.tools;
        }

        const workerBudget: LoopBudget = {
          depth: 0,
          commandFixAttempts: 0,
          prevFailedCmdSigs: [],
          writeFixAttempts: 0,
          readOnlyContinues: 0,
          terminalFingerprint: undefined
        };
        if (shouldContinueFromTools(tools, continueDecisionOpts(workerBudget))) {
          const origin: ChatMessage = {
            id: `${agentMsgId}-worker-${idx}`,
            role: 'assistant',
            raw: finished,
            display: '',
            toolCalls: tools,
            personaHandle: 'coder',
            timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
          };
          await continueWithToolResults(origin, {
            expectedFilePath,
            createIntent: true,
            node,
            model,
            budget: workerBudget,
            role: 'coder'
          });
        }

        const parsedDisplay = parseResponse(finished, `${agentMsgId}-${idx}`, false, {
          expectedFilePath,
          createIntent: true
        }).display;
        const writeErrors = tools.filter(
          t => (t.name === 'write_file' || t.name === 'edit_file') && t.status === 'error'
        );

        patchPipelineMsg(m => {
          if (!m.pipelineSteps) return m;
          const updatedSteps = [...m.pipelineSteps];
          if (updatedSteps[idx]) {
            updatedSteps[idx] = {
              ...updatedSteps[idx],
              status: writeErrors.length ? 'failed' : 'completed',
              content: writeErrors.length
                ? writeErrors.map(t => t.result || `Failed to write ${t.args?.path || expectedFilePath}`).join('\n')
                : opts.stepLabel ||
                  parsedDisplay ||
                  `Completed ${expectedFilePath}`,
              toolCalls: tools,
              stats:
                res.stats?.evalCount && res.stats?.evalDuration
                  ? {
                      evalCount: res.stats.evalCount,
                      tokensPerSec: Math.round(
                        res.stats.evalCount / (res.stats.evalDuration / 1e9)
                      )
                    }
                  : undefined
            };
          }
          const allTools = updatedSteps.flatMap(s => s.toolCalls || []);
          return { ...m, pipelineSteps: updatedSteps, toolCalls: allTools };
        });
      } catch (workerErr: any) {
        const errText = String(workerErr?.message || workerErr || '');
        const networkish =
          /timeout|abort|network|fetch|ECONN|ENOTFOUND|ECONNRESET|CUDA|out of memory|oom/i.test(errText);
        const fallback = networkish && !opts.retriedFrom
          ? nodes.find(
              n =>
                n.id !== node.id &&
                n.online &&
                !isFrontierNode(n) &&
                getEnabledModelsForNode(n).length > 0
            )
          : undefined;
        if (fallback) {
          const fallbackModel =
            getPreferredModelForNode(fallback) || getEnabledModelsForNode(fallback)[0];
          window.electronAPI?.writeLog?.(
            'warn',
            `swarm: ${node.name} failed (${errText.slice(0, 120)}); rerouting ${expectedFilePath} to ${fallback.name}`
          );
          patchPipelineMsg(m => {
            if (!m.pipelineSteps) return m;
            const updatedSteps = [...m.pipelineSteps];
            if (updatedSteps[idx]) {
              updatedSteps[idx] = {
                ...updatedSteps[idx],
                nodeId: fallback.id,
                nodeName: fallback.name,
                modelName: fallbackModel,
                status: 'running',
                content: `Rerouted from ${node.name}: ${errText.slice(0, 160)}`
              };
            }
            return { ...m, pipelineSteps: updatedSteps };
          });
          await runWorkerTurn({
            ...opts,
            assignment: { ...assignment, node: fallback, model: fallbackModel },
            retriedFrom: node.id
          });
          return;
        }
        patchPipelineMsg(m => {
          if (!m.pipelineSteps) return m;
          const updatedSteps = [...m.pipelineSteps];
          if (updatedSteps[idx]) {
            updatedSteps[idx] = {
              ...updatedSteps[idx],
              status: 'failed',
              content: `Failed on ${node.name}: ${errText}`
            };
          }
          return { ...m, pipelineSteps: updatedSteps };
        });
      }
    };

    const initialAgentMsg: ChatMessage = {
      id: agentMsgId,
      role: 'assistant',
      raw: '',
      display: architect
        ? `⚡ Pass 1 — Lead Architect (${architect.node.name} • ${architect.model} @ ~${architect.tokPerSec} tok/s${
            architect.usedFrontierBackup ? ' · frontier backup' : ' · local'
          }) is locking the shared TypeScript contract...`
        : '⚠️ No endpoints configured. Open Hardware Settings and add an Ollama node first.',
      timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
      pipelineSteps: [],
      toolCalls: []
    };

    setMessages(prev =>
      opts?.skipUserAppend ? [...prev, initialAgentMsg] : [...prev, userMsg, initialAgentMsg]
    );
    setIsStreaming(true);

    try {
      if (!architect || !architect.node?.online) {
        patchPipelineMsg({
          display:
            '⚠️ No online cluster nodes with enabled models. Open Hardware Settings, enable models on a local Ollama node (frontier APIs are backup only).'
        });
        return;
      }

      // ── Pass 1: Generate Shared Contract & Manifest ──
      const swarmTaskText = lockedPlan
        ? `${userText}\n\n${formatApprovedPlanForSwarm(lockedPlan)}`
        : userText;
      let manifest: SwarmManifest = fallbackSwarmManifest(swarmTaskText);
      try {
        const snippets = await loadExistingSnippets();
        const swarmDevHost = buildDevHostPromptSection(nodes, architect.node.id);
        const architectPrompt = buildLeadArchitectPrompt(
          swarmTaskText,
          workspaceOverview,
          snippets,
          lockedPlan ? formatApprovedPlanForSwarm(lockedPlan) : null,
          progressForPrompt() || null,
          swarmDevHost
        );
        const architectBody: Record<string, unknown> = {
          model: architect.model,
          messages: [
            {
              role: 'system',
              content:
                'You are the Lead Architect (@coder). Respond ONLY with a valid JSON object for the Swarm manifest. No markdown outside JSON. Workspace/installs/run_command target the Dev PC where Studio is open — not necessarily this inference host.'
            },
            { role: 'user', content: architectPrompt }
          ],
          options: { temperature: 0.1, num_ctx: 8192 }
        };
        if (!isFrontierNode(architect.node)) architectBody.format = 'json';
        const decompHandle = streamChat(
          architect.node.url,
          withThink(architectBody, architect.node, architect.model),
          () => {},
          architect.node.type,
          architect.node.apiKey
        );
        activeAbortsRef.current.push(decompHandle.abort);
        const decompRes = await decompHandle.done;
        recordTok(architect.node, decompRes.stats);
        const parsed = parseSwarmManifest(decompRes.content, swarmTaskText);
        if (parsed) manifest = parsed;
        else console.warn('Pass 1 JSON parse failed — using fallback manifest');
      } catch (decompErr) {
        console.warn('Pass 1 Lead Architect failed — using fallback:', decompErr);
      }

      // ── Stage 2: Write Contract & Verify Syntax ──
      patchPipelineMsg({
        display: `📝 Writing shared contract \`${manifest.contractFile}\` (${manifest.tasks.length} worker file${
          manifest.tasks.length === 1 ? '' : 's'
        })…`
      });

      const writeOk = await onApplyFileWrite(manifest.contractFile, manifest.contractCode);
      if (writeOk) {
        updateProgress(log => noteSavedFiles(log, [{ name: 'write_file', status: 'done', args: { path: manifest.contractFile } }]));
      }
      if (!writeOk) {
        patchPipelineMsg({
          display: `⚠️ Failed to write contract file \`${manifest.contractFile}\`. Aborting swarm.`
        });
        return;
      }

      if (
        manifest.stack === 'typescript' &&
        isTypeScriptContractPath(manifest.contractFile) &&
        window.electronAPI?.typecheckWorkspace &&
        workspacePath
      ) {
        let check = await window.electronAPI.typecheckWorkspace(workspacePath, {
          mode: 'contract',
          file: manifest.contractFile,
          timeoutMs: 45000
        });

        if (!check.ok) {
          patchPipelineMsg({
            display: `🔧 Contract failed tsc — Lead Architect self-correcting before waking workers…\n\`\`\`\n${(
              check.output ||
              check.error ||
              ''
            ).slice(0, 1200)}\n\`\`\``
          });
          try {
            const repairPrompt = buildContractRepairPrompt(
              swarmTaskText,
              manifest,
              check.output || check.error || 'unknown tsc error'
            );
            const repairBody: Record<string, unknown> = {
              model: architect.model,
              messages: [
                {
                  role: 'system',
                  content: 'Fix the Swarm JSON manifest so contractCode typechecks. JSON only.'
                },
                { role: 'user', content: repairPrompt }
              ],
              options: { temperature: 0.1, num_ctx: 8192 }
            };
            if (!isFrontierNode(architect.node)) repairBody.format = 'json';
            const repairHandle = streamChat(
              architect.node.url,
              withThink(repairBody, architect.node, architect.model),
              () => {},
              architect.node.type,
              architect.node.apiKey
            );
            activeAbortsRef.current.push(repairHandle.abort);
            const repairRes = await repairHandle.done;
            recordTok(architect.node, repairRes.stats);
            const repaired = parseSwarmManifest(repairRes.content, swarmTaskText);
            if (repaired) {
              manifest = repaired;
              const repairedOk = await onApplyFileWrite(manifest.contractFile, manifest.contractCode);
              if (repairedOk) {
                updateProgress(log =>
                  noteSavedFiles(log, [{ name: 'write_file', status: 'done', args: { path: manifest.contractFile } }])
                );
              }
              check = await window.electronAPI.typecheckWorkspace(workspacePath, {
                mode: 'contract',
                file: manifest.contractFile,
                timeoutMs: 45000
              });
            }
          } catch (repairErr) {
            console.warn('Contract repair failed:', repairErr);
          }

          if (!check.ok) {
            patchPipelineMsg({
              display: `⚠️ Contract still fails tsc after repair — continuing with best-effort workers.\n\`\`\`\n${(
                check.output ||
                check.error ||
                ''
              ).slice(0, 1500)}\n\`\`\``
            });
          } else {
            patchPipelineMsg({
              display: `✅ Contract \`${manifest.contractFile}\` typechecks. Fan-out Pass 2…`
            });
          }
        } else {
          patchPipelineMsg({
            display: `✅ Contract \`${manifest.contractFile}\` locked & typechecked. Fan-out Pass 2…`
          });
        }
      }

      // ── Pass 2: Fan out by dependency waves (parallel within a wave) ──
      const taskWaves = partitionSwarmTasksIntoWaves(manifest.tasks);
      const assignments: SwarmAssignment[] = [];
      const assignmentWaveIndex: number[] = [];
      taskWaves.forEach((wave, wi) => {
        const waveAssign = assignSwarmTasksToCluster(wave, nodes);
        for (const a of waveAssign) {
          assignments.push(a);
          assignmentWaveIndex.push(wi);
        }
      });
      if (!assignments.length) {
        patchPipelineMsg({
          display: '⚠️ No worker assignments produced. Check Hardware Settings for online nodes.'
        });
        return;
      }

      const localCount = assignments.filter(a => !isFrontierNode(a.node)).length;
      const frontierCount = assignments.length - localCount;
      const waveLabel =
        taskWaves.length > 1
          ? ` · ${taskWaves.length} dependency waves (foundation files first)`
          : '';

      const initialSteps: PipelineStep[] = [
        {
          nodeId: architect.node.id,
          nodeName: `${architect.node.name} → ${manifest.contractFile}`,
          modelName: architect.model,
          targetFile: manifest.contractFile,
          agentHandle: 'coder',
          role: `Lead Architect · contract${architect.usedFrontierBackup ? ' (frontier)' : ' (local)'}`,
          status: 'completed',
          content: `Locked shared contract (${manifest.tasks.length} tasks${waveLabel})`,
          toolCalls: []
        },
        ...assignments.map(({ task, node, model, skippedReason }, i) => {
          const offline = !!(skippedReason && !node.online);
          const wave = assignmentWaveIndex[i] ?? 0;
          const deps =
            task.dependsOn && task.dependsOn.length
              ? ` after ${task.dependsOn.join(', ')}`
              : '';
          return {
            nodeId: node.id,
            nodeName: `${node.name} → ${task.filePath}`,
            modelName: model,
            targetFile: task.filePath,
            agentHandle: 'coder' as const,
            role: `${task.role || task.preferredRole} · ${model}${
              isFrontierNode(node) ? ' (frontier)' : ' (local)'
            }${skippedReason ? ` — ${skippedReason}` : ''}`,
            status: (offline ? 'failed' : 'pending') as PipelineStep['status'],
            content: offline
              ? `Skipped: ${skippedReason}`
              : `Wave ${wave + 1}/${taskWaves.length}${deps} — waiting…`,
            toolCalls: [] as PipelineStep['toolCalls']
          };
        })
      ];

      patchPipelineMsg({
        display:
          frontierCount > 0 && localCount === 0
            ? `⚡ Pass 2 — ${assignments.length} files via frontier (contract locked)${waveLabel}:`
            : `⚡ Pass 2 — ${assignments.length} files in ${taskWaves.length} wave${
                taskWaves.length === 1 ? '' : 's'
              } (${localCount} local${frontierCount ? ` + ${frontierCount} frontier` : ''}). Same-wave files may run in parallel; later waves wait for dependencies:`,
        pipelineSteps: initialSteps
      });

      const completedPaths: string[] = [];
      let flatOffset = 0;
      for (let wi = 0; wi < taskWaves.length; wi++) {
        const waveAssign = assignments.slice(flatOffset, flatOffset + taskWaves[wi].length);
        flatOffset += taskWaves[wi].length;
        const waveItems = waveAssign.map((assignment, j) => {
          // pipelineSteps[0] is contract; worker steps are 1..n in assignment order
          const stepIdx = assignments.indexOf(assignment) + 1;
          return { assignment, stepIdx, j };
        });

        const priorSnippets: string[] = [];
        for (const p of completedPaths.slice(-8)) {
          const body = await readWorkspaceRel(p);
          if (body != null) {
            priorSnippets.push(
              `### ${p} (already written)\n\`\`\`\n${body.slice(0, 3500)}\n\`\`\``
            );
          }
        }
        const planSibling = waveAssign
          .map(
            a =>
              `- ${a.task.filePath} (wave ${wi + 1}${
                a.task.dependsOn?.length ? `, needs ${a.task.dependsOn.join(', ')}` : ''
              }): ${a.task.instructions.slice(0, 120)}`
          )
          .join('\n');
        const siblingSummary = [
          priorSnippets.length
            ? `## Already written (do not rewrite)\n${priorSnippets.join('\n\n')}`
            : '',
          `## This wave\n${planSibling}`
        ]
          .filter(Boolean)
          .join('\n\n');

        for (const { assignment, stepIdx } of waveItems) {
          patchPipelineMsg(m => {
            if (!m.pipelineSteps?.[stepIdx]) return m;
            const updatedSteps = [...m.pipelineSteps];
            updatedSteps[stepIdx] = {
              ...updatedSteps[stepIdx],
              status: assignment.skippedReason && !assignment.node.online ? 'failed' : 'running',
              modelName: assignment.model,
              content: `Wave ${wi + 1}: generating ${assignment.task.filePath} on ${assignment.node.name}…`
            };
            return { ...m, pipelineSteps: updatedSteps };
          });
        }

        // Parallel across GPUs within the wave; serialize per GPU URL.
        const gpuQueues = queueAssignmentsByGpu(waveAssign);
        // Fix stepIdx on work items to match global pipeline indices
        const queuesWithIdx = gpuQueues.map(queue =>
          queue.map(item => {
            const globalIdx = assignments.findIndex(
              a => a.task.filePath === item.assignment.task.filePath && a.node.id === item.assignment.node.id
            );
            return {
              assignment: item.assignment,
              stepIdx: globalIdx >= 0 ? globalIdx + 1 : item.stepIdx
            };
          })
        );

        await Promise.allSettled(
          queuesWithIdx.map(async queue => {
            for (let n = 0; n < queue.length; n++) {
              const { assignment, stepIdx } = queue[n];
              if (n > 0) {
                patchPipelineMsg(m => {
                  if (!m.pipelineSteps?.[stepIdx]) return m;
                  const updatedSteps = [...m.pipelineSteps];
                  updatedSteps[stepIdx] = {
                    ...updatedSteps[stepIdx],
                    status: 'running',
                    modelName: assignment.model,
                    content: `Wave ${wi + 1}: generating ${assignment.task.filePath} on ${assignment.node.name}…`
                  };
                  return { ...m, pipelineSteps: updatedSteps };
                });
              }
              const current = await readWorkspaceRel(assignment.task.filePath);
              const workerLog = progressForPrompt();
              const workerOverall = lockedPlan
                ? formatApprovedPlanBrief(lockedPlan)
                : userText;
              const workerPrompt = `${buildSwarmWorkerPrompt({
                task: assignment.task,
                contractFile: manifest.contractFile,
                contractCode: manifest.contractCode,
                siblingSummary,
                currentFileContent: current,
                userPrompt: workerOverall,
                stack: manifest.stack,
                devHostSection: buildDevHostPromptSection(nodes, assignment.node.id)
              })}${workerLog ? `\n\nWork log (do not redo Done steps or re-ask Already asked):\n${workerLog}` : ''}`;
              await runWorkerTurn({
                idx: stepIdx,
                assignment,
                userPrompt: workerPrompt,
                expectedFilePath: assignment.task.filePath
              });
            }
          })
        );

        for (const a of waveAssign) {
          completedPaths.push(a.task.filePath);
        }
      }

      // ── Stage 4: Verify (tsc only for TypeScript stacks) ──
      if (manifest.stack !== 'typescript' && manifest.verifyCommand) {
        patchPipelineMsg(m => ({
          ...m,
          display: `${m.display || ''}\n\n🔍 Verifying ${manifest.stack}: \`${manifest.verifyCommand}\``
        }));
        const output = await onExecuteToolCommand(manifest.verifyCommand);
        const failed = /Exit code:\s*(?!0\b)\d+/i.test(output) || /timed out/i.test(output);
        patchPipelineMsg(m => ({
          ...m,
          display: failed
            ? `⚠️ Conductor Swarm finished ${assignments.length} file(s). Verify failed:\n\`\`\`\n${output.slice(0, 2000)}\n\`\`\``
            : `✅ Conductor Swarm finished ${assignments.length} file(s). ${manifest.stack} check passed.`
        }));
      } else if (manifest.stack === 'typescript' && window.electronAPI?.typecheckWorkspace && workspacePath) {
        patchPipelineMsg(m => ({
          ...m,
          display: `${m.display || ''}\n\n🔍 Running workspace \`tsc --noEmit\`…`
        }));

        const wsCheck = await window.electronAPI.typecheckWorkspace(workspacePath, {
          mode: 'workspace',
          timeoutMs: 90000
        });

        if (wsCheck.skipped) {
          patchPipelineMsg(m => ({
            ...m,
            display: `✅ Conductor Swarm finished ${assignments.length} worker file(s). ${wsCheck.output || 'No tsconfig — skipped project typecheck.'}`
          }));
        } else if (wsCheck.ok) {
          patchPipelineMsg(m => ({
            ...m,
            display: `✅ Conductor Swarm finished ${assignments.length} worker file(s). Workspace typecheck passed.`
          }));
        } else {
          const byFile = groupTscErrorsByFile(wsCheck.output || '', workspacePath);
          const repairJobs: { idx: number; assignment: SwarmAssignment; errors: string }[] = [];

          assignments.forEach((assignment, i) => {
            const key = assignment.task.filePath.replace(/\\/g, '/').toLowerCase();
            let errors = '';
            for (const [file, err] of byFile.entries()) {
              if (file.toLowerCase().replace(/\\/g, '/').endsWith(key) || file.toLowerCase() === key) {
                errors = err;
                break;
              }
            }
            if (errors) {
              repairJobs.push({ idx: i + 1, assignment, errors });
            }
          });

          if (!repairJobs.length) {
            patchPipelineMsg(m => ({
              ...m,
              display: `⚠️ Workspace tsc reported errors, but none mapped to swarm-owned files.\n\`\`\`\n${(
                wsCheck.output || ''
              ).slice(0, 2000)}\n\`\`\``
            }));
          } else {
            patchPipelineMsg(m => ({
              ...m,
              display: `🔧 Targeted repair — re-prompting ${repairJobs.length} GPU owner(s) with tsc stderr…`
            }));

            const repairQueues = new Map<string, typeof repairJobs>();
            for (const job of repairJobs) {
              const key = endpointQueueKey(job.assignment.node);
              const queue = repairQueues.get(key) ?? [];
              queue.push(job);
              repairQueues.set(key, queue);
            }

            await Promise.allSettled(
              [...repairQueues.values()].map(async queue => {
                for (const { idx, assignment, errors } of queue) {
                  patchPipelineMsg(m => {
                    if (!m.pipelineSteps?.[idx]) return m;
                    const updatedSteps = [...m.pipelineSteps];
                    updatedSteps[idx] = {
                      ...updatedSteps[idx],
                      status: 'running',
                      content: `Repairing ${assignment.task.filePath} from tsc errors…`
                    };
                    return { ...m, pipelineSteps: updatedSteps };
                  });

                  const current =
                    (await readWorkspaceRel(assignment.task.filePath)) ||
                    '(file missing after Pass 2)';
                  const repairPrompt = buildRepairWorkerPrompt({
                    task: assignment.task,
                    contractFile: manifest.contractFile,
                    contractCode: manifest.contractCode,
                    currentFileContent: current,
                    tscErrors: errors,
                    devHostSection: buildDevHostPromptSection(nodes, assignment.node.id)
                  });
                  await runWorkerTurn({
                    idx,
                    assignment,
                    userPrompt: repairPrompt,
                    expectedFilePath: assignment.task.filePath,
                    stepLabel: `Repaired ${assignment.task.filePath}`
                  });
                }
              })
            );

            const recheck = await window.electronAPI.typecheckWorkspace(workspacePath, {
              mode: 'workspace',
              timeoutMs: 90000
            });
            patchPipelineMsg(m => ({
              ...m,
              display: recheck.ok
                ? `✅ Conductor Swarm finished — workspace typecheck passed after targeted repair.`
                : `⚠️ Conductor Swarm finished with remaining type errors after repair.\n\`\`\`\n${(
                    recheck.output || ''
                  ).slice(0, 2000)}\n\`\`\``
            }));
          }
        }
      } else {
        patchPipelineMsg(m => ({
          ...m,
          display: `✅ Conductor Swarm completed parallel generation of ${assignments.length} files (contract: \`${manifest.contractFile}\`).`
        }));
      }
    } catch (err: any) {
      console.error('Pipeline error:', err);
      window.electronAPI?.writeLog?.('error', `swarm: ${err?.message || err}`);
      patchPipelineMsg({
        display: `⚠️ Conductor Swarm error: ${err?.message || err}`
      });
    } finally {
      setIsStreaming(false);
      activeAbortsRef.current = [];
    }
  };

  // ==========================================
  // STANDARD SINGLE-TASK EXECUTION (+ Planner → Coder)
  // ==========================================

  const resolveRoute = (userText: string, agent: AgentPersona) => {
    const routedNode = autoSelectEndpoint
      ? selectBestEndpointForTask(userText, agent.handle, nodes)
      : selectedNode;
    if (!routedNode) return null;
    const routedModel = autoSelectEndpoint
      ? getPreferredModelForNode(routedNode, activeTargetModel) || activeTargetModel
      : activeTargetModel;
    return { routedNode, routedModel, routedIsFrontier: routedNode.type === 'openai' || !!routedNode.apiKey };
  };

  /** Single-node chat turn with optional plan/review/contract mode or locked approved plan. */
  const runSingleNodeTurn = async (opts: {
    userText: string;
    fullPrompt: string;
    attachedImages?: string[];
    agent: AgentPersona;
    planMode?: boolean;
    reviewMode?: boolean;
    /** Planner locks fix contract after review (writes OK; no plan_options) */
    contractMode?: boolean;
    /** Planner emits <execution_plan> after option pick */
    lockPlanMode?: boolean;
    /** Reviewer Yay/Nay on active Planner step */
    stepVerdictMode?: boolean;
    approvedPlan?: ApprovedPlan | null;
    userMsgExtra?: Partial<ChatMessage>;
    skipUserAppend?: boolean;
    notice?: string;
    /** Keep a fix on the review model instead of the worker that wrote the files. */
    pinRoute?: { node: EndpointNode; model: string };
  }): Promise<ChatMessage | undefined> => {
    const {
      userText,
      fullPrompt,
      attachedImages = [],
      agent,
      planMode,
      reviewMode,
      contractMode,
      lockPlanMode,
      stepVerdictMode,
      approvedPlan,
      userMsgExtra,
      skipUserAppend,
      notice,
      pinRoute
    } = opts;
    const readOnlyMode = !!planMode || !!reviewMode || !!lockPlanMode || !!stepVerdictMode;

    const route = pinRoute
      ? {
          routedNode: pinRoute.node,
          routedModel: pinRoute.model,
          routedIsFrontier: pinRoute.node.type === 'openai' || !!pinRoute.node.apiKey
        }
      : resolveRoute(userText, agent);
    if (!route) {
      setMessages(prev => [
        ...prev,
        ...(skipUserAppend
          ? []
          : [
              {
                id: `msg-${Date.now()}`,
                role: 'user' as const,
                raw: userText,
                display: userText,
                timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
                ...(attachedImages.length ? { images: attachedImages } : {}),
                ...userMsgExtra
              }
            ]),
        {
          id: `agent-${Date.now()}`,
          role: 'assistant' as const,
          raw: '',
          display:
            '⚠️ No endpoints configured. Open Hardware Settings and add an Ollama node (e.g. http://127.0.0.1:11434).',
          timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
          toolCalls: []
        }
      ]);
      return;
    }

    const { routedNode, routedModel, routedIsFrontier } = route;
    if (routedNode.id !== targetNodeId) setTargetNodeId(routedNode.id);
    if (routedModel !== targetModel) setTargetModel(routedModel);

    const createIntent = !readOnlyMode && looksLikeCreateIntent(userText);
    const userMsg: ChatMessage = {
      id: `msg-${Date.now()}`,
      role: 'user',
      raw: userText,
      display: userText,
      timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
      ...(attachedImages.length ? { images: attachedImages } : {}),
      ...userMsgExtra
    };

    const agentMsgId = `agent-${Date.now()}`;
    const initialAgentMsg: ChatMessage = {
      id: agentMsgId,
      role: 'assistant',
      raw: '',
      display: notice || '',
      agentId: agent.id,
      personaHandle: agent.handle,
      endpointId: routedNode.id,
      endpointName: routedNode.name,
      model: routedModel,
      timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
      toolCalls: [],
      ...(notice ? { notice } : {})
    };

    setMessages(prev => (skipUserAppend ? [...prev, initialAgentMsg] : [...prev, userMsg, initialAgentMsg]));
    setIsStreaming(true);

    let originOut: ChatMessage | undefined;
    try {
      fitContext(chatNumCtx(routedNode, routedModel));
      const systemPrompt = buildSystemPrompt(agent, workspacePath, workspaceOverview, {
        planMode: !!planMode,
        reviewMode: !!reviewMode,
        contractMode: !!contractMode,
        lockPlanMode: !!lockPlanMode,
        stepVerdictMode: !!stepVerdictMode,
        approvedPlan: readOnlyMode || contractMode || lockPlanMode ? null : approvedPlan,
        progressLog: progressForPrompt(),
        nodes,
        inferenceNodeId: routedNode.id
      });
      const actionableUserPrompt = lockPlanMode
        ? `${fullPrompt}\n\n[PLANNER LOCK DIRECTIVE: Break the chosen option into ordered steps with coder tasks. End with <execution_plan>. Do NOT write deliverable files. Do NOT emit <plan_options>.]`
        : stepVerdictMode
          ? `${fullPrompt}\n\n[REVIEWER STEP DIRECTIVE: Verify ONLY the active plan step. End with <step_verdict> yay or nay. Do NOT write files or invent a new plan.]`
          : planMode
            ? `${fullPrompt}\n\n[PLANNER DIRECTIVE: Analyze intent, propose a concrete plan, and end with 2–4 options in a <plan_options> block. Do NOT write deliverable files yet.]`
            : reviewMode
              ? `${fullPrompt}\n\n[REVIEWER DIRECTIVE: Report findings and end with a <review_plan> block (tasks if fixes are needed, summary-only if clean). Do NOT write or edit files.]`
              : contractMode
                ? `${fullPrompt}\n\n[PLANNER CONTRACT DIRECTIVE: Lock a fix contract for the review tasks. You may write a shared contract file. End with <fix_contract>. Do NOT emit <plan_options>. Do not implement the full fix list — Coder runs next.]`
                : pinRoute
                  ? `${fullPrompt}\n\n[EXECUTION DIRECTIVE: Fix the existing files with <edit_file path="..."> search/replace blocks. Do not rewrite a whole file when a search/replace will do. Do not add a new feature.]`
                  : `${fullPrompt}\n\n[EXECUTION DIRECTIVE: If this request asks to create, build, or modify an application, script, or file, you MUST emit <write_file path="filename.ext">...complete code...</write_file> tags so the files are written directly to the user's computer. Do NOT just reply with conversational instructions.]`;
      const ollamaImages = attachedImages.map(toOllamaBase64);

      const history = historyForModel(messagesRef.current, stripThinking);
      const draftTokens = estimateTokens(
        [systemPrompt, ...history.map(m => m.content), actionableUserPrompt].join('\n')
      );
      let userContent = actionableUserPrompt;
      let historySent = history;
      if (!routedIsFrontier && contextOverflow(draftTokens, chatNumCtx(routedNode, routedModel))) {
        try {
          const brief = await requestFreeTierBrief(
            `The local model context is ${chatNumCtx(routedNode, routedModel)} tokens and this job does not fit. Brief the coder.`,
            [systemPrompt, ...history.map(m => `${m.role}: ${m.content}`), actionableUserPrompt].join('\n\n')
          );
          if (brief) {
            userContent = `${actionableUserPrompt}\n\n[FREE-TIER BRIEF — the rest of the context did not fit this model. Trust this brief.]\n${brief}`;
            historySent = history.slice(-2);
            setExecutingPlanNotice(`Context did not fit ${routedModel}. Using a short free-tier brief.`);
          }
        } catch (err: any) {
          window.electronAPI?.writeLog?.('warn', `free-tier assist: ${err?.message || err}`);
        }
      }
      if (stopRequestedRef.current) return undefined;

      const conversationPayload = [
        { role: 'system', content: systemPrompt },
        ...historySent,
        {
          role: 'user',
          content: userContent,
          ...(ollamaImages.length ? { images: ollamaImages } : {})
        }
      ];

      const body = withThink(
        {
          model: routedModel,
          messages: conversationPayload,
          options: {
            temperature: agent.temperature,
            num_ctx: chatNumCtx(routedNode, routedModel)
          }
        },
        routedNode,
        routedModel
      );

      const handle = streamChat(
        routedNode.url,
        body,
        (content, thinking) => {
          const parsed = parseResponse(content, agentMsgId, true, { createIntent });
          let displayBase = stripPlanOptionMarkup(parsed.display || content);
          if (reviewMode || stepVerdictMode) {
            displayBase = stripStepVerdictMarkup(
              stripReviewDeltaMarkup(stripReviewPlanMarkup(displayBase))
            );
          }
          if (lockPlanMode) displayBase = stripExecutionPlanMarkup(displayBase);
          if (contractMode) displayBase = stripFixContractMarkup(displayBase);
          // Never surface architecture options once an execution plan is locked/running.
          const liveOptions =
            planMode && !lockPlanMode && !isPlanActive(plannerPlanRef.current)
              ? parsePlanOptions(content)
              : [];
          const liveReview = reviewMode && !stepVerdictMode ? parseReviewPlan(content) : null;
          const liveVerdict = stepVerdictMode ? parseStepVerdict(content) : null;
          const liveTools = collapseDuplicateReadTools(
            readOnlyMode
              ? parsed.toolCalls.filter(t =>
                  ['read_file', 'list_dir', 'search', 'read_terminal'].includes(t.name)
                )
              : parsed.toolCalls
          );
          setMessages(prev =>
            prev.map(m => {
              if (m.id !== agentMsgId) return m;
              return {
                ...m,
                raw: content,
                display: displayBase,
                thinking: parsed.thinking || thinking,
                toolCalls: liveTools,
                ...(liveOptions.length >= 2
                  ? { planOptions: liveOptions, planSummary: buildPlanSummary(content, liveOptions) }
                  : {}),
                ...(liveReview ? { reviewPlan: liveReview } : {}),
                ...(liveVerdict
                  ? {
                      stepVerdict: {
                        stepId: liveVerdict.stepId || getActiveStep(plannerPlanRef.current)?.id || '',
                        stepTitle: getActiveStep(plannerPlanRef.current)?.title || 'Step',
                        result: liveVerdict.result,
                        notes: liveVerdict.notes
                      }
                    }
                  : {})
              };
            })
          );
        },
        routedNode.type,
        routedNode.apiKey
      );

      activeAbortsRef.current = [handle.abort];
      const result = await handle.done;
      const finished = readOnlyMode
        ? result.content
        : await finishTruncatedWrites(routedNode, routedModel, result.content, result.stats?.doneReason);
      const finalParsed = parseResponse(finished, agentMsgId, false, { createIntent });

      let tools = collapseDuplicateReadTools(finalParsed.toolCalls);
      if (readOnlyMode) {
        // Planner / Reviewer: explore only — drop accidental write/edit/run tools
        tools = tools.filter(t =>
          ['read_file', 'list_dir', 'search', 'read_terminal'].includes(t.name)
        );
      }

      const readPass = await runReadOnlyTools(tools, toolDeps);
      tools = readPass.tools;

      if (!readOnlyMode && autoApplyWritesRef.current) {
        tools = await autoApplyWritableTools(tools, toolDeps);
        tools = await runAuxTools(tools, toolDeps);
        const cmdPass = await runCommandTools(tools, toolDeps);
        tools = cmdPass.tools;
        updateProgress(log => noteSavedFiles(log, tools));
      }

      let stats = undefined;
      if (result.stats?.evalCount && result.stats?.evalDuration) {
        const tps = Math.round(result.stats.evalCount / (result.stats.evalDuration / 1e9));
        stats = {
          evalCount: result.stats.evalCount,
          tokensPerSec: tps,
          promptTokens: result.stats.promptEvalCount,
          loadMs: result.stats.loadDuration ? Math.round(result.stats.loadDuration / 1e6) : undefined
        };
        if (routedIsFrontier) {
          onRecordTokens(0, result.stats.evalCount + (result.stats.promptEvalCount || 0));
        } else {
          onRecordTokens(result.stats.evalCount + (result.stats.promptEvalCount || 0), 0);
        }
      }

      const options =
        planMode && !lockPlanMode && !isPlanActive(plannerPlanRef.current)
          ? parsePlanOptions(finished)
          : [];
      const reviewPlan =
        reviewMode && !stepVerdictMode
          ? parseReviewPlan(finished) ||
            ({
              summary: 'No structured issues found.',
              tasks: []
            } as const)
          : null;
      const parsedVerdict = stepVerdictMode ? parseStepVerdict(finished) : null;
      let displayText = stripPlanOptionMarkup(finalParsed.display || finished);
      if (reviewMode || stepVerdictMode) {
        displayText = stripStepVerdictMarkup(
          stripReviewDeltaMarkup(stripReviewPlanMarkup(displayText))
        );
      }
      if (lockPlanMode) displayText = stripExecutionPlanMarkup(displayText);
      if (contractMode) displayText = stripFixContractMarkup(displayText);

      const origin: ChatMessage = {
        id: agentMsgId,
        role: 'assistant',
        raw: finished,
        display: displayText,
        thinking: finalParsed.thinking || result.thinking,
        toolCalls: tools,
        stats,
        timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
        agentId: agent.id,
        personaHandle: agent.handle,
        endpointId: routedNode.id,
        endpointName: routedNode.name,
        model: routedModel,
        ...(options.length > 0
          ? {
              planOptions: options,
              planSummary: buildPlanSummary(finished, options)
            }
          : {}),
        ...(reviewPlan ? { reviewPlan } : {}),
        ...(parsedVerdict
          ? {
              stepVerdict: {
                stepId: parsedVerdict.stepId || getActiveStep(plannerPlanRef.current)?.id || '',
                stepTitle: getActiveStep(plannerPlanRef.current)?.title || 'Step',
                result: parsedVerdict.result,
                notes: parsedVerdict.notes
              }
            }
          : {}),
        ...(notice ? { notice } : {})
      };

      setMessages(prev => prev.map(m => (m.id === agentMsgId ? origin : m)));
      originOut = origin;

      const turnContinueOpts = continueDecisionOpts(undefined, {
        maxReadOnlyContinues:
          reviewMode || stepVerdictMode ? 1 : planMode || lockPlanMode ? 2 : undefined
      });
      const continueRole =
        (agent.handle as 'planner' | 'reviewer' | 'coder' | 'docs') ||
        (planMode || lockPlanMode
          ? 'planner'
          : reviewMode || stepVerdictMode
            ? 'reviewer'
            : 'coder');
      if (!readOnlyMode && shouldContinueFromTools(tools, turnContinueOpts)) {
        await continueWithToolResults(origin, {
          createIntent,
          node: routedNode,
          model: routedModel,
          role: continueRole,
          lockPlanMode: !!lockPlanMode,
          reviewMode: !!reviewMode || !!stepVerdictMode,
          stepVerdictMode: !!stepVerdictMode
        });
      } else if (readOnlyMode && shouldContinueFromTools(tools, turnContinueOpts)) {
        // Planner/Reviewer: bounded explore continues, then they must emit the plan
        await continueWithToolResults(origin, {
          createIntent: false,
          node: routedNode,
          model: routedModel,
          role: continueRole,
          lockPlanMode: !!lockPlanMode,
          reviewMode: !!reviewMode || !!stepVerdictMode,
          stepVerdictMode: !!stepVerdictMode
        });
        // After tool continuations, refresh reviewPlan from latest follow-up if reviewer
        if (reviewMode && !stepVerdictMode) {
          const latest = [...messagesRef.current].reverse().find(
            m => m.personaHandle === 'reviewer' && m.role === 'assistant'
          );
          if (latest) {
            const rp = coerceDirtyReviewPlan(
              latest.reviewPlan || parseReviewPlan(latest.raw || ''),
              `${latest.display || ''}\n${latest.raw || ''}`
            );
            originOut = { ...latest, reviewPlan: rp };
            setMessages(prev =>
              prev.map(m => (m.id === latest.id ? { ...m, reviewPlan: rp } : m))
            );
          }
        }
      }
    } catch (err: any) {
      window.electronAPI?.writeLog?.('error', `single-node ${routedNode?.name || ''}: ${err?.message || err}`);
      setMessages(prev =>
        prev.map(m => {
          if (m.id === agentMsgId) {
            return {
              ...m,
              display: m.display + `\n\n⚠️ Error on ${routedNode.name}: ${err.message}`
            };
          }
          return m;
        })
      );
    } finally {
      setIsStreaming(false);
      activeAbortsRef.current = [];
    }
    return originOut;
  };

  /**
   * Planner orchestrates ONE active queue task → fix contract → Coder, then Reviewer verifies that task.
   * Seeds the durable queue from planMsg when needed; never drops the list.
   */
  const sendReviewPlanToPlanner = async (
    planMsg?: ChatMessage | null,
    resumeDepth?: number,
    reviewNotes?: string
  ) => {
    if (planMsg?.reviewSentToCoder && !executionQueueRef.current) return;

    const depth =
      resumeDepth ?? pendingReviewResumeRef.current?.depth ?? 0;
    pendingReviewResumeRef.current = null;

    let queue = executionQueueRef.current;
    if ((!queue || !queue.tasks.length) && planMsg?.reviewPlan?.tasks.length) {
      queue = createQueueFromReviewPlan(planMsg.reviewPlan, planMsg.id);
      commitExecutionQueue(queue);
    }
    if (!queue?.tasks.length) return;

    let task = getActiveTask(queue);
    if (!task || task.status === 'completed') {
      const next = pickNextPending(queue);
      if (!next) {
        if (autoReviewRef.current) await decideNextStepAndAdvance(depth, '');
        return;
      }
      queue = markInProgress(queue, next.id);
      commitExecutionQueue(queue);
      task = getActiveTask(queue)!;
    } else if (task.status === 'pending' || task.status === 'failed') {
      queue = markInProgress(queue, task.id);
      commitExecutionQueue(queue);
      task = getActiveTask(queue)!;
    }

    if (planMsg) {
      setMessages(prev => {
        const snap = queueToReviewPlan(queue!);
        const next = prev.map(m =>
          m.id === planMsg.id
            ? { ...m, reviewSentToCoder: true, reviewPlan: snap }
            : m
        );
        messagesRef.current = next;
        return next;
      });
    }

    const singlePlan = formatActiveTaskForPlanner(queue, task, reviewNotes);
    const openLeft = queue.tasks.filter(
      t => t.status === 'pending' || t.status === 'failed'
    ).length;

    onSelectAgent(plannerAgent.id);
    resetAgentLoopBudget();
    stopRequestedRef.current = false;

    const plannerPrompt = formatReviewPlanForPlanner(
      singlePlan,
      reviewNotes || planMsg?.display
    );
    setExecutingPlanNotice(
      `Planner contract for task #${task.id}${openLeft ? ` (${openLeft} remaining after)` : ''}…`
    );

    if (isPipelineMode) {
      const syntheticPlan: ApprovedPlan = {
        summary: singlePlan.summary,
        chosenOptionId: 'review-fix',
        chosenOptionTitle: `Fix task #${task.id}: ${task.title}`,
        chosenOptionDescription: task.description,
        allOptions: [],
        originalUserRequest: `Review fix task #${task.id}: ${task.title}`,
        approvedAt: Date.now(),
        planMarkdown: plannerPrompt
      };
      approvedPlanRef.current = syntheticPlan;
      onConversationPatch?.({ approvedPlan: syntheticPlan, agentId: plannerAgent.id });
      await handleSendPipelineMessage(
        `Review fix task #${task.id}: ${task.title}`,
        plannerPrompt,
        { approvedPlan: syntheticPlan, skipUserAppend: true }
      );
      if (!stopRequestedRef.current) {
        await reviewAndAdvance(depth + 1, `Task #${task.id}: ${task.title}`);
      }
      return;
    }

    const plannerMsg = await runSingleNodeTurn({
      userText: `Planner: fix contract for task #${task.id}`,
      fullPrompt: plannerPrompt,
      agent: plannerAgent,
      planMode: false,
      reviewMode: false,
      contractMode: true,
      skipUserAppend: true,
      notice: `Planner locking fix contract — task #${task.id}`
    });

    if (stopRequestedRef.current) return;

    const plannerBrief = extractFixContractBrief(
      plannerMsg?.raw || '',
      plannerMsg?.display || ''
    );

    onSelectAgent(coderAgent.id);
    onConversationPatch?.({ agentId: coderAgent.id });
    if (coderAgent.autoApproveWrites !== undefined) {
      autoApplyWritesRef.current = coderAgent.autoApproveWrites;
      setAutoApplyWrites(coderAgent.autoApproveWrites);
    }

    const coderPrompt = formatReviewPlanForCoder(
      singlePlan,
      reviewNotes || planMsg?.display,
      plannerBrief
    );
    setExecutingPlanNotice(`Coder applying task #${task.id}: ${task.title}…`);

    await runSingleNodeTurn({
      userText: `Implement review task #${task.id}: ${task.title}`,
      fullPrompt: coderPrompt,
      agent: coderAgent,
      planMode: false,
      reviewMode: false,
      contractMode: false,
      approvedPlan: approvedPlanRef.current,
      notice: `Coder implementing task #${task.id}`
    });
    if (!stopRequestedRef.current) {
      await reviewAndAdvance(depth + 1, `Task #${task.id}: ${task.title}`);
    }
  };

  /** User approved a clean review — resume next-step continuation. */
  const continueAfterCleanReview = async (planMsg: ChatMessage) => {
    if (!planMsg.reviewNeedsContinue) return;
    const resume = pendingReviewResumeRef.current;
    pendingReviewResumeRef.current = null;
    setMessages(prev => {
      const next = prev.map(m =>
        m.id === planMsg.id
          ? { ...m, reviewSentToCoder: true, reviewNeedsContinue: false }
          : m
      );
      messagesRef.current = next;
      return next;
    });
    setExecutingPlanNotice('Continuing after clean review…');
    await decideNextStepAndAdvance(resume?.depth ?? 0, resume?.previousTask ?? '');
  };

  /**
   * After a clean Reviewer pass (or user Continue), decide continue / ask / done.
   * Does not write files — Reviewer → Planner → Coder owns fixes.
   */
  const decideNextStepAndAdvance = async (depth: number, previousTask = ''): Promise<void> => {
    if (stopRequestedRef.current) return;

    // Planner-owned plan is the sole controller — never invent next steps while active.
    if (isPlanActive(plannerPlanRef.current)) {
      const step = getActiveStep(plannerPlanRef.current);
      if (step && (step.status === 'in_progress' || step.status === 'failed')) {
        await dispatchActiveStep();
      } else if (plannerPlanRef.current?.status === 'completed') {
        setExecutingPlanNotice('Planner plan complete — ask Planner for the next feature if needed.');
      }
      return;
    }

    // Legacy flat queue still has work — Planner dispatches; do not invent a new feature step.
    if (hasOpenTasks(executionQueueRef.current)) {
      await sendReviewPlanToPlanner(null, depth);
      return;
    }

    const recent = messagesRef.current;
    const target = pickCapableReviewTarget(nodes);
    if (!target) return;
    const { node, model } = target;
    const touchedPaths = collectWrittenPaths(recent);
    const capped = depth >= MAX_AUTO_CONTINUATIONS;
    const transcript = recent
      .slice(-8)
      .map(m => {
        const who = m.role === 'user' ? 'User' : m.personaHandle || 'Assistant';
        const text = (m.display || '').replace(/\s+/g, ' ').trim().slice(0, 600);
        return text ? `${who}: ${text}` : '';
      })
      .filter(Boolean)
      .join('\n');
    const planText = approvedPlanRef.current
      ? formatApprovedPlanContext(approvedPlanRef.current)
      : '';
    const userContent = buildContinuationReviewPrompt({
      approvedPlanText: planText,
      recentTranscript: transcript,
      workspaceOverview,
      workLog: progressForPrompt(),
      writtenPaths: touchedPaths,
      capped
    });

    const agentMsgId = `next-${Date.now()}`;
    const stamp = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    setExecutingPlanNotice(capped ? 'Out of automatic steps — asking what to do next' : 'Checking what is left…');
    setMessages(prev => [
      ...prev,
      {
        id: agentMsgId,
        role: 'assistant',
        raw: '',
        display: '',
        agentId: coderAgent.id,
        personaHandle: coderAgent.handle,
        endpointId: node.id,
        endpointName: node.name,
        model,
        timestamp: stamp,
        notice: `Planning next step on ${node.name}`,
        toolCalls: []
      }
    ]);
    setIsStreaming(true);

    let handoff = false;
    let nextTask = '';
    let pinFix = false;
    let pinStuck: { node: EndpointNode; model: string } | undefined;
    let handledLoop = false;
    try {
      const askModel = async (content: string, prior: { role: string; content: string }[]) => {
        const body = withThink(
          {
            model,
            messages: [
              {
                role: 'system',
                content:
                  CONTINUATION_REVIEW_SYSTEM +
                  '\n\nDo NOT use <edit_file> or <write_file>. Reviewer already checked the files; only emit <next_step>.'
              },
              ...prior,
              { role: 'user', content }
            ],
            options: { temperature: 0.2, num_ctx: chatNumCtx(node, model) }
          },
          node,
          model
        );
        const handle = streamChat(
          node.url,
          body,
          (chunk, thinking) => {
            const shown = stripNextStepMarkup(stripPlanOptionMarkup(stripThinking(chunk)));
            setMessages(prev =>
              prev.map(m =>
                m.id === agentMsgId
                  ? { ...m, raw: chunk, display: shown, thinking: thinking || m.thinking }
                  : m
              )
            );
          },
          node.type,
          node.apiKey
        );
        activeAbortsRef.current = [handle.abort];
        return handle.done;
      };

      const first = await askModel(
        `${userContent}\n\nReviewer already cleared this step (no open fix tasks). Decide <next_step> only — do not edit files.`,
        []
      );
      if (first.aborted || stopRequestedRef.current) return;
      if (first.stats?.evalCount) {
        const tokens = first.stats.evalCount + (first.stats.promptEvalCount || 0);
        if (node.type === 'openai' || node.apiKey) onRecordTokens(0, tokens);
        else onRecordTokens(tokens, 0);
      }

      let content = first.content;
      let readTools: ToolCall[] = [];
      const firstReads = parseResponse(content, agentMsgId, false).toolCalls.filter(t =>
        ['read_file', 'list_dir', 'search'].includes(t.name)
      );
      if (firstReads.length && !stopRequestedRef.current) {
        const ran = await runReadOnlyTools(firstReads, toolDeps);
        readTools = ran.tools;
        setMessages(prev =>
          prev.map(m => (m.id === agentMsgId ? { ...m, toolCalls: ran.tools } : m))
        );
        const follow = `Tool results:\n${ran.tools
          .map(t => `${t.name} ${t.args.path || t.args.query || ''}: ${(t.result || '').slice(0, 1200)}`)
          .join('\n\n')}\n\nDo not edit files. End with exactly one <next_step> block.`;
        const second = await askModel(follow, [
          { role: 'user', content: userContent },
          { role: 'assistant', content: content }
        ]);
        if (second.aborted || stopRequestedRef.current) return;
        if (second.content.trim()) content = second.content;
        if (second.stats?.evalCount) {
          const tokens = second.stats.evalCount + (second.stats.promptEvalCount || 0);
          if (node.type === 'openai' || node.apiKey) onRecordTokens(0, tokens);
          else onRecordTokens(tokens, 0);
        }
      }

      const reviewTools = readTools;
      const parsedDecision = parseNextStep(content);
      const durableFallback = (progressRef.current.bug || progressRef.current.next || '').trim();
      const filteredDecision = parsedDecision
        ? filterInspectionContinue(parsedDecision, durableFallback)
        : null;
      const steered = filteredDecision
        ? avoidRepeat(
            progressRef.current,
            filteredDecision.decision,
            filteredDecision.task,
            filteredDecision.options
          )
        : null;
      const decision = filteredDecision
        ? { ...filteredDecision, decision: steered!.decision, task: steered!.task, options: steered!.options }
        : null;
      const visible = parseResponse(content, agentMsgId, false).display || stripThinking(content);
      const prose = stripNextStepMarkup(stripPlanOptionMarkup(visible));
      let options = decision?.options || [];
      let display = steered?.note || prose || decision?.reason || '';
      let runTask = '';

      const repeatTask =
        (steered && isRepeatStop(steered.note) && (parsedDecision?.task || previousTask || '').trim()) || '';
      const similarTask =
        !repeatTask &&
        decision?.decision === 'continue' &&
        !!previousTask &&
        tasksTooSimilar(previousTask, decision.task)
          ? decision.task
          : '';
      const loopTask = stripKeepFixingPrefix(repeatTask || similarTask).trim();
      if (loopTask) {
        handledLoop = true;
        const key = stuckKey(loopTask);
        const stage: StuckStage = resolveStuckStage(stuckRef.current, key);
        let step = nextStuckStage(stage);
        stuckRef.current = { key, stage };
        const stuckPayload = `${progressForPrompt()}\n\nStuck step:\n${loopTask}`;
        if (step === 'big') {
          const big = pickLargestLocalTarget(nodes);
          if (big) {
            stuckRef.current.stage = 'big';
            handoff = true;
            nextTask = loopTask;
            pinFix = true;
            pinStuck = big;
            runTask = loopTask;
            options = [];
            display = `Stuck repeating. Retrying on ${big.node.name} · ${big.model} (${big.node.hardware?.vramGB || 0} GB) with a different approach.`;
          } else {
            step = 'free';
          }
        }
        if (step === 'free') {
          stuckRef.current.stage = 'free';
          let brief: string | null = null;
          try {
            brief = await requestFreeTierBrief(
              'The local models are repeating this step and not fixing it. Give one short solution. Do not rewrite the file.',
              stuckPayload
            );
          } catch (err: any) {
            window.electronAPI?.writeLog?.('warn', `free-tier stuck: ${err?.message || err}`);
          }
          if (brief) {
            const big = pickLargestLocalTarget(nodes);
            display = `Free-tier solution:\n\n${brief}`;
            options = [{ id: 'copy-solution', title: 'Copy solution', description: brief, action: 'copy' }];
            if (big) {
              handoff = true;
              nextTask = `Apply this solution. Do not repeat the failed approach.\n\n${brief}`;
              pinFix = true;
              pinStuck = big;
              runTask = nextTask;
            }
          } else {
            step = 'paid';
          }
        }
        if (step === 'paid') {
          stuckRef.current.stage = 'paid';
          const paid = pickPaidFrontier(nodes);
          const big = pickLargestLocalTarget(nodes);
          handoff = false;
          runTask = '';
          nextTask = '';
          pinStuck = undefined;
          pinFix = false;
          if (paid) {
            display = `Still stuck after the largest local model and the free tier. Confirm before a paid call to ${paid.node.name} · ${paid.model}, or retry locally with a different approach.`;
            options = [
              ...(big
                ? [
                    {
                      id: 'retry-local',
                      title: `Retry differently · ${big.model}`,
                      description: loopTask,
                      action: 'retry-local' as const
                    }
                  ]
                : []),
              {
                id: 'use-paid-api',
                title: `Use paid API · ${paid.model}`,
                description: loopTask,
                action: 'paid' as const
              },
              {
                id: 'stop-stuck',
                title: 'Stop — I will give a new instruction',
                description: loopTask,
                action: 'stop' as const
              }
            ];
          } else {
            // No paid node: do not dead-end — offer local retry + stop. Local planning never required frontier.
            display = big
              ? `Still stuck after local retries (free-tier assist unavailable or empty). No paid API is required — retry on ${big.node.name} · ${big.model} with a different approach, or send a concrete new instruction.`
              : 'Still stuck after local retries. No paid API is required. Send a concrete new instruction (file + what to change).';
            options = big
              ? [
                  {
                    id: 'retry-local',
                    title: `Retry differently · ${big.model}`,
                    description: loopTask,
                    action: 'retry-local' as const
                  },
                  {
                    id: 'stop-stuck',
                    title: 'Stop — I will give a new instruction',
                    description: loopTask,
                    action: 'stop' as const
                  }
                ]
              : [
                  {
                    id: 'stop-stuck',
                    title: 'Stop — I will give a new instruction',
                    description: loopTask,
                    action: 'stop' as const
                  }
                ];
          }
        }
      }

      if (!handledLoop && decision?.decision === 'continue' && !capped && !tasksTooSimilar(previousTask, decision.task)) {
        runTask = decision.task;
        display = display || `Continuing automatically.\n\n${decision.reason}`;
        options = [];
      } else if (!handledLoop && decision?.decision === 'continue') {
        display =
          display ||
          `${decision.reason}\n\nI can keep going with: ${decision.task}`;
        if (!options.length) {
          options = [
            {
              id: '1',
              title: 'Keep going',
              description: decision.task
            }
          ];
        }
      } else if (!handledLoop && decision?.decision === 'done') {
        display = display || decision.reason || 'The requested work looks complete.';
      } else if (!handledLoop && decision?.decision === 'ask') {
        display = display || decision.reason || 'Need a choice before continuing.';
      }

      if (runTask && !handledLoop) display = `Continuing — ${runTask}`;

      setMessages(prev =>
        prev.map(m =>
          m.id === agentMsgId
            ? {
                ...m,
                raw: content,
                display,
                toolCalls: reviewTools,
                ...(options.length
                  ? { planOptions: options, planSummary: buildPlanSummary(content, options) }
                  : {})
              }
            : m
        )
      );

      if (runTask && !handledLoop) {
        handoff = true;
        nextTask = runTask;
        pinFix = taskFixesWrittenFiles(runTask, touchedPaths);
        updateProgress(log => advanceNext(log, runTask));
      } else if (runTask && handledLoop) {
        updateProgress(log => advanceNext(log, runTask));
      } else if (options.length) {
        updateProgress(log => options.reduce((acc, option) => rememberAsked(acc, `${option.title}: ${option.description}`), log));
      }
      if (!handledLoop && !runTask && (decision?.decision === 'done' || decision?.decision === 'ask' || options.length)) {
        setExecutingPlanNotice(
          decision?.decision === 'done' ? 'Work looks complete — optional next steps below' : 'Waiting for a choice'
        );
      } else if (handledLoop && options.some(o => o.action === 'paid')) {
        setExecutingPlanNotice('Waiting for confirmation before a paid API call');
      } else if (!handoff) {
        setExecutingPlanNotice(null);
      }
    } catch (err: any) {
      window.electronAPI?.writeLog?.('error', `continuation check: ${err?.message || err}`);
      setMessages(prev =>
        prev.map(m =>
          m.id === agentMsgId
            ? { ...m, display: (m.display || '') + `\n\n⚠️ Could not check the next step: ${err.message}` }
            : m
        )
      );
      setExecutingPlanNotice(null);
    } finally {
      if (!handoff) {
        setIsStreaming(false);
        activeAbortsRef.current = [];
      }
    }

    if (!handoff || stopRequestedRef.current) return;

    const stuckTarget = pinStuck;
    setExecutingPlanNotice(
      stuckTarget
        ? `Retrying on ${stuckTarget.node.name} — ${nextTask.slice(0, 90)}`
        : `Continuing — ${nextTask.slice(0, 110)}`
    );
    const planPrefix = approvedPlanRef.current
      ? `${formatApprovedPlanContext(approvedPlanRef.current)}\n\n`
      : '';
    await runSingleNodeTurn({
      userText: `Continue: ${nextTask}`,
      fullPrompt: stuckTarget
        ? `${planPrefix}STUCK RETRY — you already repeated this step. Do NOT repeat the same approach. Use a different concrete <edit_file>/<write_file> fix, or stop and state the blocker in one sentence.\n\n${nextTask}`
        : pinFix
          ? `${planPrefix}NEXT STEP — fix the existing files with <edit_file>. Do not rewrite a file from scratch when a search/replace will do. Do not add a new feature.\n\n${nextTask}`
          : `${planPrefix}NEXT STEP — do this now, then stop. Do not expand into unrelated features.\n\n${nextTask}`,
      agent: coderAgent,
      planMode: false,
      approvedPlan: approvedPlanRef.current,
      notice: stuckTarget
        ? `Stuck-loop retry on ${stuckTarget.node.name} · ${stuckTarget.model}`
        : pinFix
          ? `Fixing on ${node.name} — ${nextTask.slice(0, 120)}`
          : `Continuing automatically — ${nextTask.slice(0, 140)}`,
      ...(stuckTarget ? { pinRoute: stuckTarget } : pinFix ? { pinRoute: { node, model } } : {})
    });
    if (stopRequestedRef.current) return;
    await reviewAndAdvance(depth + 1, nextTask);
  };

  /**
   * After a coding step: Reviewer checks work.
   * - Active PlannerPlan → step Yay/Nay (reviewActiveStep).
   * - Legacy flat queue → review_delta / seed review_plan.
   */
  const reviewAndAdvance = async (depth: number, previousTask = ''): Promise<void> => {
    if (stopRequestedRef.current) return;

    if (isPlanActive(plannerPlanRef.current)) {
      await reviewActiveStep();
      return;
    }

    const recent = messagesRef.current;
    let userIdx = recent.length - 1;
    while (userIdx >= 0 && recent[userIdx].role !== 'user') userIdx -= 1;
    const sinceUser = recent.slice(Math.max(0, userIdx));
    const didWork =
      !!approvedPlanRef.current ||
      !!executionQueueRef.current ||
      sinceUser.some(m =>
        (m.pipelineSteps && m.pipelineSteps.length > 0) ||
        (m.toolCalls || []).some(t =>
          t.name === 'write_file' ||
          t.name === 'edit_file' ||
          t.name === 'run_command' ||
          t.name === 'generate_image'
        )
      );
    if (depth === 0 && !didWork) return;

    const target = pickCapableReviewTarget(nodes);
    if (!target) {
      if (autoReviewRef.current) await decideNextStepAndAdvance(depth, previousTask);
      return;
    }

    const touchedPaths = collectWrittenPaths(recent);
    const planText = approvedPlanRef.current
      ? formatApprovedPlanContext(approvedPlanRef.current)
      : '';
    const transcript = recent
      .slice(-6)
      .map(m => {
        const who = m.role === 'user' ? 'User' : m.personaHandle || 'Assistant';
        const text = (m.display || '').replace(/\s+/g, ' ').trim().slice(0, 500);
        return text ? `${who}: ${text}` : '';
      })
      .filter(Boolean)
      .join('\n');
    const filesHint = touchedPaths.length
      ? `Files just written/edited:\n${touchedPaths.slice(0, 12).join('\n')}`
      : 'No write/edit paths recorded — review the latest coding step from chat context.';
    const filesBody = await buildTouchedFilesContext(workspacePath, touchedPaths, {
      maxFiles: 8,
      maxCharsPerFile: 5000,
      maxTotalChars: 20000
    });

    const existingQueue = executionQueueRef.current;
    const activeTask = getActiveTask(existingQueue);
    const deltaMode =
      !!existingQueue &&
      !!activeTask &&
      (activeTask.status === 'in_progress' || activeTask.status === 'failed');

    const reviewPrompt = deltaMode
      ? `${planText ? `${planText}\n\n` : ''}${formatQueueForReviewer(existingQueue!, activeTask!)}

${filesHint}

${filesBody || '(No file bodies loaded — at most two read_file calls, then verdict.)'}

Recent chat:
${transcript || '(none)'}

Work log:
${progressForPrompt() || '(empty)'}

Verify ONLY active task #${activeTask!.id}. End with <review_delta task_id="${activeTask!.id}">.
Do NOT emit a new <review_plan>. Do NOT write or edit files. Do not re-read files already shown above.`
      : `${planText ? `${planText}\n\n` : ''}## Post-step review (seed durable task list)
Check the work that just finished for bugs, broken wiring, and missing behavior.
${filesHint}

${filesBody || '(No file bodies loaded — at most two read_file calls, then emit <review_plan>.)'}

Recent chat:
${transcript || '(none)'}

Work log:
${progressForPrompt() || '(empty)'}

Prefer the file contents above. At most two extra reads, then end with a <review_plan> (tasks if fixes needed; summary-only if clean).
This list will be kept by Planner — do not expect to replace it later. Do NOT write or edit files.`;

    setExecutingPlanNotice(
      autoReviewRef.current
        ? deltaMode
          ? `Reviewer verifying task #${activeTask!.id}…`
          : 'Reviewer checking the work…'
        : 'Reviewer checking — waiting for your approval after'
    );

    const reviewMsg = await runSingleNodeTurn({
      userText: deltaMode
        ? `Verify task #${activeTask!.id}: ${activeTask!.title}`
        : 'Review the latest coding step',
      fullPrompt: reviewPrompt,
      agent: reviewerAgent,
      reviewMode: true,
      skipUserAppend: true,
      notice: `Reviewer checking on ${target.node.name}`,
      pinRoute: target
    });

    if (stopRequestedRef.current) return;

    const latestReview =
      reviewMsg ||
      [...messagesRef.current].reverse().find(
        m => m.role === 'assistant' && (m.personaHandle === 'reviewer' || m.reviewPlan)
      );
    const rawBlob = `${latestReview?.display || ''}\n${latestReview?.raw || ''}`;

    // —— Delta path: update durable queue status; never reseed from a new full plan ——
    if (deltaMode && existingQueue && activeTask) {
      let delta = parseReviewDelta(latestReview?.raw || '');
      if (!delta) {
        const parsedPlan =
          latestReview?.reviewPlan ||
          (latestReview ? parseReviewPlan(latestReview.raw || '') : null) ||
          ({ summary: 'No structured issues found.', tasks: [] } as const);
        const coerced = coerceDirtyReviewPlan(parsedPlan, rawBlob);
        if (coerced.tasks.length === 0) {
          delta = {
            taskId: activeTask.id,
            verdict: 'completed',
            notes: coerced.summary || 'Looks good.'
          };
        } else {
          delta = {
            taskId: activeTask.id,
            verdict: 'failed',
            notes:
              coerced.tasks.map(t => t.description).join(' ') ||
              coerced.summary ||
              'Active task not completed correctly.'
          };
        }
      }

      const updated = applyReviewDelta(existingQueue, {
        ...delta,
        taskId: delta.taskId || activeTask.id
      });
      commitExecutionQueue(updated);
      const snap = queueToReviewPlan(updated);

      if (latestReview) {
        setMessages(prev => {
          const next = prev.map(m =>
            m.id === latestReview.id
              ? {
                  ...m,
                  reviewPlan: snap,
                  reviewSentToCoder: false,
                  reviewNeedsContinue: !autoReviewRef.current
                }
              : m
          );
          messagesRef.current = next;
          return next;
        });
      }

      const after = getActiveTask(updated) || updated.tasks.find(t => t.id === activeTask.id);
      const failed = after?.status === 'failed';
      const completed = after?.status === 'completed';

      if (failed) {
        if (autoReviewRef.current) {
          await sendReviewPlanToPlanner(
            latestReview ? { ...latestReview, reviewPlan: snap } : null,
            depth,
            after?.failureNote
          );
          return;
        }
        pendingReviewResumeRef.current = { depth, previousTask };
        setExecutingPlanNotice(
          `Task #${activeTask.id} failed review — Send to Planner when ready`
        );
        return;
      }

      if (completed) {
        if (hasOpenTasks(updated)) {
          if (autoReviewRef.current) {
            await sendReviewPlanToPlanner(null, depth);
            return;
          }
          pendingReviewResumeRef.current = { depth, previousTask };
          setExecutingPlanNotice('Task done — Send to Planner for the next queued task');
          return;
        }
        // Queue finished
        if (!autoReviewRef.current) {
          if (latestReview) {
            setMessages(prev => {
              const next = prev.map(m =>
                m.id === latestReview.id
                  ? { ...m, reviewPlan: snap, reviewNeedsContinue: true }
                  : m
              );
              messagesRef.current = next;
              return next;
            });
          }
          pendingReviewResumeRef.current = { depth, previousTask };
          setExecutingPlanNotice('All review tasks done — click Looks good / Continue');
          return;
        }
        await decideNextStepAndAdvance(depth, previousTask);
        return;
      }
    }

    // —— Seed path: first review creates the durable list once ——
    const parsedPlan =
      latestReview?.reviewPlan ||
      (latestReview ? parseReviewPlan(latestReview.raw || '') : null) ||
      ({ summary: 'No structured issues found.', tasks: [] } as const);
    const plan = coerceDirtyReviewPlan(parsedPlan, rawBlob);

    if (plan.tasks.length > 0) {
      // Keep an existing unfinished queue; only seed when empty
      if (!hasOpenTasks(executionQueueRef.current)) {
        const seeded = createQueueFromReviewPlan(plan, latestReview?.id);
        commitExecutionQueue(seeded);
      }
      const snap = queueToReviewPlan(executionQueueRef.current!);
      if (latestReview) {
        setMessages(prev => {
          const next = prev.map(m =>
            m.id === latestReview.id ? { ...m, reviewPlan: snap } : m
          );
          messagesRef.current = next;
          return next;
        });
      }
      const planMsg = latestReview
        ? { ...latestReview, reviewPlan: snap }
        : null;

      if (autoReviewRef.current) {
        await sendReviewPlanToPlanner(planMsg, depth);
        return;
      }
      pendingReviewResumeRef.current = { depth, previousTask };
      setExecutingPlanNotice('Review found issues — Send to Planner when ready');
      return;
    }

    if (latestReview && (!latestReview.reviewPlan || latestReview.reviewPlan.tasks.length !== plan.tasks.length)) {
      setMessages(prev => {
        const next = prev.map(m => (m.id === latestReview.id ? { ...m, reviewPlan: plan } : m));
        messagesRef.current = next;
        return next;
      });
    }

    const planMsg = latestReview ? { ...latestReview, reviewPlan: plan } : null;

    if (!autoReviewRef.current) {
      if (planMsg) {
        setMessages(prev => {
          const next = prev.map(m =>
            m.id === planMsg.id
              ? { ...m, reviewPlan: plan, reviewNeedsContinue: true }
              : m
          );
          messagesRef.current = next;
          return next;
        });
      }
      pendingReviewResumeRef.current = { depth, previousTask };
      setExecutingPlanNotice('Review looks clean — click Looks good / Continue');
      return;
    }

    await decideNextStepAndAdvance(depth, previousTask);
  };

  /** Dispatch the active Planner step to Coders (sequential single-node or Swarm for the step). */
  const dispatchActiveStep = async (): Promise<void> => {
    if (stopRequestedRef.current) return;
    let plan = plannerPlanRef.current;
    if (!plan || plan.status !== 'active') return;

    let step = getActiveStep(plan);
    if (!step || step.status === 'completed') {
      plan = activateNextStep(plan);
      commitPlannerPlan(plan);
      if (plan.status === 'completed') {
        setExecutingPlanNotice('Planner plan complete.');
        return;
      }
      step = getActiveStep(plan);
    }
    if (!step) return;

    plan = markStepInProgress(plan, step.id);
    commitPlannerPlan(plan);
    step = getActiveStep(plan)!;

    onSelectAgent(coderAgent.id);
    onConversationPatch?.({ agentId: coderAgent.id });
    if (coderAgent.autoApproveWrites !== undefined) {
      autoApplyWritesRef.current = coderAgent.autoApproveWrites;
      setAutoApplyWrites(coderAgent.autoApproveWrites);
    }

    resetAgentLoopBudget();
    stopRequestedRef.current = false;

    const coderPrompt = formatStepForCoders(plan, step);
    setExecutingPlanNotice(`Coder(s) on step #${step.id}: ${step.title}…`);

    if (isPipelineMode) {
      const synthetic: ApprovedPlan = {
        summary: `${plan.summary} — step ${step.id}`,
        chosenOptionId: plan.chosenOptionId || 'plan-step',
        chosenOptionTitle: step.title,
        chosenOptionDescription: step.tasks.map(t => `${t.id}. ${t.title}: ${t.description}`).join('\n'),
        allOptions: [],
        originalUserRequest: `Plan step #${step.id}: ${step.title}`,
        approvedAt: Date.now(),
        planMarkdown: coderPrompt
      };
      approvedPlanRef.current = synthetic;
      onConversationPatch?.({ approvedPlan: synthetic });
      await handleSendPipelineMessage(`Plan step #${step.id}: ${step.title}`, coderPrompt, {
        approvedPlan: synthetic,
        skipUserAppend: true
      });
    } else {
      await runSingleNodeTurn({
        userText: `Implement plan step #${step.id}: ${step.title}`,
        fullPrompt: coderPrompt,
        agent: coderAgent,
        planMode: false,
        approvedPlan: approvedPlanRef.current,
        skipUserAppend: true,
        notice: `Coder implementing step #${step.id}`
      });
    }

    if (stopRequestedRef.current) return;

    // Mark step tasks done for coder pass; Reviewer Yay/Nay is the real gate.
    plan = plannerPlanRef.current;
    if (plan && step) {
      plan = markAllStepTasks(plan, step.id, 'completed');
      commitPlannerPlan(plan);
    }
    await reviewActiveStep();
  };

  /** Reviewer Yay/Nay on the active Planner step. */
  const reviewActiveStep = async (): Promise<void> => {
    if (stopRequestedRef.current) return;
    const plan = plannerPlanRef.current;
    const step = getActiveStep(plan);
    if (!plan || !step) {
      if (plan?.status === 'completed') {
        setExecutingPlanNotice('Planner plan complete.');
      }
      return;
    }

    const target = pickCapableReviewTarget(nodes);
    if (!target) {
      setExecutingPlanNotice('No reviewer-capable node online for step verdict.');
      return;
    }

    const touchedPaths = collectWrittenPaths(messagesRef.current);
    const filesHint = touchedPaths.length
      ? `Files just written/edited:\n${touchedPaths.slice(0, 16).join('\n')}`
      : 'Review from chat context and the step task list.';
    const filesBody = await buildTouchedFilesContext(workspacePath, touchedPaths, {
      maxFiles: 8,
      maxCharsPerFile: 5000,
      maxTotalChars: 20000
    });

    const reviewPrompt = `${formatStepForReviewer(plan, step)}

${filesHint}

${filesBody || '(No file bodies loaded — use at most two read_file calls, then verdict.)'}

Work log:
${progressForPrompt() || '(empty)'}

After reviewing the files above, emit <step_verdict> immediately. Do not re-read the same paths.`;

    setExecutingPlanNotice(
      autoReviewRef.current
        ? `Reviewer Yay/Nay on step #${step.id}…`
        : `Reviewer checking step #${step.id} — waiting for your approval`
    );

    const reviewMsg = await runSingleNodeTurn({
      userText: `Verify plan step #${step.id}: ${step.title}`,
      fullPrompt: reviewPrompt,
      agent: reviewerAgent,
      reviewMode: true,
      stepVerdictMode: true,
      skipUserAppend: true,
      notice: `Reviewer on ${target.node.name} — step #${step.id}`,
      pinRoute: target
    });

    if (stopRequestedRef.current) return;

    const latest =
      reviewMsg ||
      [...messagesRef.current].reverse().find(
        m => m.role === 'assistant' && (m.stepVerdict || m.personaHandle === 'reviewer')
      );

    let verdict = latest?.stepVerdict
      ? {
          stepId: latest.stepVerdict.stepId,
          result: latest.stepVerdict.result,
          notes: latest.stepVerdict.notes
        }
      : parseStepVerdict(latest?.raw || '');

    if (!verdict) {
      // Infer from prose when markup missing
      const blob = `${latest?.display || ''}\n${latest?.raw || ''}`;
      const dirty =
        /\b(bug|issue|missing|broken|incorrect|fail|wrong|incomplete)\b/i.test(blob) &&
        !/\b(no (blocking )?issues|looks correct|all good)\b/i.test(blob);
      verdict = {
        stepId: step.id,
        result: dirty ? 'nay' : 'yay',
        notes: (latest?.display || '').slice(0, 400) || (dirty ? 'Needs refining.' : 'Looks good.')
      };
    }

    const packed = {
      stepId: verdict.stepId || step.id,
      stepTitle: step.title,
      result: verdict.result,
      notes: verdict.notes
    };

    if (latest) {
      setMessages(prev => {
        const next = prev.map(m =>
          m.id === latest.id
            ? {
                ...m,
                stepVerdict: packed,
                stepVerdictNeedsConfirm: !autoReviewRef.current,
                stepVerdictApplied: false
              }
            : m
        );
        messagesRef.current = next;
        return next;
      });
    }

    if (!autoReviewRef.current) {
      setExecutingPlanNotice(
        packed.result === 'yay'
          ? `Step #${step.id} Yay — click Accept to continue`
          : `Step #${step.id} Nay — click Accept to send fixes to Coder`
      );
      return;
    }

    await applyStepVerdictAndContinue(
      latest ? { ...latest, stepVerdict: packed } : null,
      packed
    );
  };

  /** Apply Yay/Nay to durable plan, then next step or rework. */
  const applyStepVerdictAndContinue = async (
    verdictMsg: ChatMessage | null,
    packed?: { stepId: string; stepTitle: string; result: 'yay' | 'nay'; notes: string }
  ): Promise<void> => {
    const v = packed || verdictMsg?.stepVerdict;
    if (!v) return;
    if (verdictMsg?.stepVerdictApplied) return;

    let plan = plannerPlanRef.current;
    if (!plan) return;

    plan = applyStepVerdict(plan, {
      stepId: v.stepId,
      result: v.result,
      notes: v.notes
    });
    commitPlannerPlan(plan);

    if (verdictMsg) {
      setMessages(prev => {
        const next = prev.map(m =>
          m.id === verdictMsg.id
            ? { ...m, stepVerdictApplied: true, stepVerdictNeedsConfirm: false }
            : m
        );
        messagesRef.current = next;
        return next;
      });
    }

    if (plan.status === 'completed') {
      setExecutingPlanNotice('All plan steps complete.');
      return;
    }

    if (v.result === 'nay') {
      setExecutingPlanNotice(`Reworking step #${v.stepId} from Reviewer Nay…`);
      await dispatchActiveStep();
      return;
    }

    // Yay — next step already activated by applyStepVerdict
    const next = getActiveStep(plan);
    if (next) {
      setExecutingPlanNotice(`Step Yay — starting step #${next.id}: ${next.title}`);
      await dispatchActiveStep();
    } else {
      setExecutingPlanNotice('Planner plan complete.');
    }
  };

  /** After the user picks a plan option — Planner locks steps/tasks, then Coders run step 1. */
  const executeChosenPlan = async (
    option: PlanOption,
    planMsg: ChatMessage,
    confirmationText: string,
    attachedImages: string[] = []
  ) => {
    const original = findPlanOriginalRequest(messagesRef.current, planMsg);
    const approved = buildApprovedPlan(planMsg, option, original);
    approvedPlanRef.current = approved;
    executionQueueRef.current = null;
    commitPlannerPlan(null);

    onSelectAgent(plannerAgent.id);
    onConversationPatch?.({
      approvedPlan: approved,
      executionQueue: null,
      plannerPlan: null,
      agentId: plannerAgent.id
    });

    const confirmDisplay = confirmationText.trim() || `Option ${option.id}: ${option.title}`;
    updateProgress(log => noteUserTurn(log, `${option.title}. ${option.description}`));
    fitContext(chatNumCtx(selectedNode, activeTargetModel));
    const userConfirm: ChatMessage = {
      id: `msg-${Date.now()}`,
      role: 'user',
      raw: confirmDisplay,
      display: confirmDisplay,
      timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
      chosenPlanOptionId: option.id,
      personaHandle: 'planner',
      ...(attachedImages.length ? { images: attachedImages } : {})
    };
    setMessages(prev => {
      const marked = prev.map(m =>
        m.id === planMsg.id ? { ...m, selectedPlanOptionId: option.id } : m
      );
      const next = [...marked, userConfirm];
      messagesRef.current = next;
      return next;
    });

    resetAgentLoopBudget();
    stopRequestedRef.current = false;

    const lockPrompt = `${formatApprovedPlanContext(approved)}

## Chosen option
${option.id}. ${option.title}
${option.description}

Break this into ordered <execution_plan> steps with concrete coder tasks. Do not implement code.`;

    setExecutingPlanNotice(`Planner locking execution plan for Option ${option.id}…`);

    const lockMsg = await runSingleNodeTurn({
      userText: `Lock execution plan for option ${option.id}`,
      fullPrompt: lockPrompt,
      attachedImages,
      agent: plannerAgent,
      lockPlanMode: true,
      skipUserAppend: true,
      notice: `Planner writing steps for Option ${option.id}`
    });

    if (stopRequestedRef.current) return;

    const raw = lockMsg?.raw || '';
    let parsed = parseExecutionPlan(raw);
    if (!parsed?.steps.length) {
      // Fallback: one step from the chosen option so orchestration can still run
      parsed = {
        summary: option.title,
        steps: [
          {
            id: '1',
            title: option.title,
            description: option.description,
            tasks: [
              {
                id: '1a',
                title: option.title,
                description: option.description || approved.originalUserRequest
              }
            ]
          }
        ]
      };
    }

    let plan = createPlanFromParsed(parsed, {
      conversationId: conversationIdRef.current || undefined,
      chosenOptionId: option.id,
      chosenOptionTitle: option.title
    });
    plan = activateNextStep(plan);
    commitPlannerPlan(plan);
    setExecutingPlanNotice(`Plan locked (${plan.steps.length} steps) — dispatching step 1…`);

    await dispatchActiveStep();
  };

  /** User chose "Retry differently" after the stuck ladder — one more local attempt, new approach. */
  const retryStuckLocally = async (task: string) => {
    const cleaned = stripKeepFixingPrefix(task).trim();
    if (!cleaned) return;
    const big = pickLargestLocalTarget(nodes);
    if (!big) {
      setExecutingPlanNotice('No local model online to retry.');
      return;
    }
    stuckRef.current = { key: stuckKey(cleaned), stage: 'big' };
    setExecutingPlanNotice(`Retrying differently on ${big.node.name} · ${big.model}`);
    resetAgentLoopBudget();
    stopRequestedRef.current = false;
    await runSingleNodeTurn({
      userText: `Retry differently: ${cleaned}`,
      fullPrompt: `You already repeated this step without finishing it. Do NOT repeat the same approach.\n\nEither:\n1) Implement a concrete different fix with <edit_file> / <write_file>, or\n2) Stop and state what is blocking in one short sentence.\n\nStuck step:\n${cleaned}`,
      agent: coderAgent,
      planMode: false,
      reviewMode: false,
      approvedPlan: approvedPlanRef.current,
      notice: `Stuck retry (different approach) on ${big.node.name} · ${big.model}`,
      pinRoute: big
    });
    if (!stopRequestedRef.current) await reviewAndAdvance(0, cleaned);
  };

  const confirmPaidAssist = async (task: string) => {
    const paid = pickPaidFrontier(nodes);
    if (!paid || !task.trim()) return;
    setIsStreaming(true);
    setExecutingPlanNotice(`Asking ${paid.node.name} · ${paid.model}…`);
    let brief: string | null = null;
    try {
      brief = await requestAssistBrief(
        paid,
        'The local models are repeating this step and not fixing it. Give one short solution. Do not rewrite the file.',
        `${progressForPrompt()}\n\nStuck step:\n${task}`,
        false
      );
    } catch (err: any) {
      window.electronAPI?.writeLog?.('warn', `paid stuck: ${err?.message || err}`);
    }
    if (!brief || stopRequestedRef.current) {
      setIsStreaming(false);
      setExecutingPlanNotice(brief ? null : 'The paid API did not return a solution.');
      return;
    }
    const stamp = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    setMessages(prev => [
      ...prev,
      {
        id: `paid-${Date.now()}`,
        role: 'assistant',
        raw: brief,
        display: `Paid API solution:\n\n${brief}`,
        agentId: coderAgent.id,
        personaHandle: coderAgent.handle,
        endpointId: paid.node.id,
        endpointName: paid.node.name,
        model: paid.model,
        timestamp: stamp,
        notice: `Paid solution from ${paid.node.name}`,
        planOptions: [{ id: 'copy-paid', title: 'Copy solution', description: brief, action: 'copy' }]
      }
    ]);
    const big = pickLargestLocalTarget(nodes);
    if (!big) {
      setIsStreaming(false);
      setExecutingPlanNotice('Paid solution is in the chat. No local model is online to apply it.');
      return;
    }
    await runSingleNodeTurn({
      userText: 'Continue: apply the paid API solution',
      fullPrompt: `Apply this solution from the paid API. Do not repeat the failed approach.\n\n${brief}`,
      agent: coderAgent,
      planMode: false,
      approvedPlan: approvedPlanRef.current,
      notice: `Applying the paid solution on ${big.node.name} · ${big.model}`,
      pinRoute: big
    });
    if (!stopRequestedRef.current) await reviewAndAdvance(0, brief);
  };

  const handleSelectPlanOption = (option: PlanOption, planMsg: ChatMessage) => {
    if (option.action === 'copy') {
      void navigator.clipboard.writeText(option.description);
      return;
    }
    if (isStreaming || planMsg.selectedPlanOptionId) return;
    if (option.action === 'paid') {
      setMessages(prev =>
        prev.map(m => (m.id === planMsg.id ? { ...m, selectedPlanOptionId: option.id } : m))
      );
      void confirmPaidAssist(option.description);
      return;
    }
    if (option.action === 'retry-local') {
      setMessages(prev =>
        prev.map(m => (m.id === planMsg.id ? { ...m, selectedPlanOptionId: option.id } : m))
      );
      void retryStuckLocally(option.description);
      return;
    }
    if (option.action === 'stop') {
      setMessages(prev =>
        prev.map(m => (m.id === planMsg.id ? { ...m, selectedPlanOptionId: option.id } : m))
      );
      stuckRef.current = { key: '', stage: 'none' };
      setExecutingPlanNotice(null);
      return;
    }
    void executeChosenPlan(option, planMsg, `Option ${option.id}: ${option.title}`);
  };

  const handleSendMessage = async (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    const hasImages = pendingImages.length > 0;
    if ((!input.trim() && !hasImages) || isStreaming) return;

    const attachedImages = [...pendingImages];
    const userText =
      input.trim() ||
      (hasImages
        ? 'Look at this screenshot and explain what you see. Identify any errors, UI issues, or what I might need help with.'
        : '');
    setInput('');
    setPendingImages([]);
    updateProgress(log => noteUserTurn(log, userText));
    fitContext(chatNumCtx(selectedNode, activeTargetModel));
    resetAgentLoopBudget();
    stopRequestedRef.current = false;
    stuckRef.current = { key: '', stage: 'none' };

    let fullPrompt = userText;
    if (includeActiveFile && activeTab) {
      fullPrompt = `[Active File: ${activeTab.name}]\n\`\`\`${activeTab.language}\n${activeTab.content}\n\`\`\`\n\nUser Task / Request:\n${userText}`;
    }

    // Match "option 1" / "1" / title against the last pending Planner options
    const pendingPlan = findPendingPlanMessage(messagesRef.current);
    if (pendingPlan?.planOptions?.length) {
      const matched = matchPlanOption(userText, pendingPlan.planOptions);
      if (matched) {
        return executeChosenPlan(matched, pendingPlan, userText, attachedImages);
      }
    }

    // New request clears a prior locked plan / review queue unless we're mid-option-match
    if (approvedPlanRef.current && isPlannerSelected) {
      approvedPlanRef.current = null;
      executionQueueRef.current = null;
      commitPlannerPlan(null);
      onConversationPatch?.({ approvedPlan: null, executionQueue: null, plannerPlan: null });
      setExecutingPlanNotice(null);
    }

    // Planner selected → plan + options (no Swarm fan-out until option chosen)
    if (isPlannerSelected) {
      setExecutingPlanNotice(null);
      // Disable older unchosen option cards so only the new proposal is active
      setMessages(prev => {
        const next = prev.map(m =>
          m.planOptions?.length && !m.selectedPlanOptionId
            ? { ...m, selectedPlanOptionId: 'dismissed' }
            : m
        );
        messagesRef.current = next;
        return next;
      });
      return runSingleNodeTurn({
        userText,
        fullPrompt,
        attachedImages,
        agent: currentAgent,
        planMode: true
      });
    }

    // Reviewer selected → findings + review_plan only (Send to Planner → Coder)
    if (isReviewerSelected) {
      setExecutingPlanNotice(null);
      return runSingleNodeTurn({
        userText,
        fullPrompt,
        attachedImages,
        agent: currentAgent,
        reviewMode: true
      });
    }

    // Image paste skips parallel pipeline — vision needs a single multimodal turn
    if (isPipelineMode && !hasImages) {
      await handleSendPipelineMessage(userText, fullPrompt, {
        approvedPlan: approvedPlanRef.current
      });
    } else {
      await runSingleNodeTurn({
        userText,
        fullPrompt,
        attachedImages,
        agent: currentAgent,
        planMode: false,
        approvedPlan: approvedPlanRef.current
      });
    }
    if (!stopRequestedRef.current) await reviewAndAdvance(0);
  };

  const handleStop = () => {
    stopRequestedRef.current = true;
    pendingReviewResumeRef.current = null;
    activeAbortsRef.current.forEach(abort => abort());
    activeAbortsRef.current = [];
    setIsStreaming(false);
    setExecutingPlanNotice(null);
  };

  const handleApplyAllTools = async (msg: ChatMessage) => {
    if (!msg.toolCalls || msg.toolCalls.length === 0) return;
    setIsStreaming(true);
    resetAgentLoopBudget();

    const updated: ToolCall[] = [];
    for (const tool of msg.toolCalls) {
      if (tool.status === 'done' || tool.status === 'error') {
        updated.push(tool);
        continue;
      }
      updated.push(await executeTool(tool, toolDeps));
    }

    updateProgress(log => noteSavedFiles(log, updated));
    const nextMsg: ChatMessage = { ...msg, toolCalls: updated };
    setMessages(prev => prev.map(m => (m.id === msg.id ? nextMsg : m)));
    setIsStreaming(false);

    if (shouldContinueFromTools(updated, continueDecisionOpts())) {
      await continueWithToolResults(nextMsg, { createIntent: true });
    }
  };

  const conductorInfo = findLeadArchitect(nodes) || findFastestConductor(nodes);
  const latestAssistant = [...messages].reverse().find(m => m.role === 'assistant');
  const activityLabel = streamingActivityLabel(latestAssistant);

  const handleNewChatClick = () => {
    if (isStreaming) {
      activeAbortsRef.current.forEach(abort => abort());
      activeAbortsRef.current = [];
      setIsStreaming(false);
    }
    onNewChat();
  };

  const handleSelectChat = (id: string) => {
    if (id === conversation?.id) {
      setHistoryOpen(false);
      return;
    }
    if (isStreaming) {
      activeAbortsRef.current.forEach(abort => abort());
      activeAbortsRef.current = [];
      setIsStreaming(false);
    }
    onSelectConversation(id);
  };

  // Ctrl/Cmd+L → new chat (Cursor-like)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'l' && !e.shiftKey && !e.altKey) {
        e.preventDefault();
        handleNewChatClick();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  const [controlColWidth, setControlColWidth] = useState(controlWidth);
  const controlColWidthRef = useRef(controlWidth);
  const [resizingControl, setResizingControl] = useState(false);
  useEffect(() => {
    setControlColWidth(controlWidth);
    controlColWidthRef.current = controlWidth;
  }, [controlWidth]);
  useEffect(() => {
    if (!resizingControl) return;
    const onMove = (e: MouseEvent) => {
      const el = document.getElementById('agent-conductor-root');
      if (!el) return;
      const rect = el.getBoundingClientRect();
      const next = Math.max(220, Math.min(420, rect.right - e.clientX));
      controlColWidthRef.current = next;
      setControlColWidth(next);
    };
    const onUp = () => {
      setResizingControl(false);
      onControlWidthChange?.(controlColWidthRef.current);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
  }, [resizingControl, onControlWidthChange]);

  return (
    <div
      id="agent-conductor-root"
      style={{ width }}
      className="h-full bg-[#161619] border-l border-[#27272a] flex flex-row select-none shrink-0 min-w-0"
    >
      {/* Left — Conversation */}
      <div className="flex-1 min-w-[240px] flex flex-col min-h-0 overflow-hidden">
      <div className="p-3 border-b border-[#27272a] bg-[#121215] flex flex-col space-y-2 shrink-0">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center space-x-1.5 text-xs font-bold text-zinc-200 min-w-0">
            <Sparkles className="w-3.5 h-3.5 text-indigo-400 shrink-0" />
            <span className="truncate" title={conversation?.title || 'Conversation'}>
              {conversation?.title || 'Conversation'}
            </span>
          </div>

          <div className="flex items-center space-x-1 shrink-0">
            <div className="relative">
              <button
                type="button"
                onClick={() => setHistoryOpen(o => !o)}
                className={`p-1 rounded transition ${
                  historyOpen ? 'bg-indigo-600/30 text-indigo-200' : 'text-zinc-400 hover:text-white hover:bg-[#202026]'
                }`}
                title="Chat history"
              >
                <History className="w-3.5 h-3.5" />
              </button>
              {historyOpen && (
                <div className="absolute right-0 top-full mt-1 z-40 w-64 max-h-72 overflow-y-auto bg-[#1a1a20] border border-[#2e2e3a] rounded-lg shadow-xl py-1">
                  <div className="px-2.5 py-1.5 text-[10px] uppercase tracking-wide text-zinc-500 font-semibold">
                    This workspace
                  </div>
                  {workspaceConversations.length === 0 ? (
                    <div className="px-2.5 py-3 text-[11px] text-zinc-500">No chats yet</div>
                  ) : (
                    workspaceConversations.map(c => (
                      <div
                        key={c.id}
                        className={`group flex items-start gap-1 px-1.5 py-0.5 ${
                          c.id === conversation?.id ? 'bg-indigo-600/20' : 'hover:bg-[#252530]'
                        }`}
                      >
                        <button
                          type="button"
                          onClick={() => handleSelectChat(c.id)}
                          className="flex-1 text-left px-1.5 py-1.5 min-w-0"
                        >
                          <div className="text-[11px] text-zinc-200 truncate font-medium">{c.title}</div>
                          <div className="text-[9px] text-zinc-500 mt-0.5">
                            {formatConversationTime(c.updatedAt)} · {c.messages.length} msgs
                          </div>
                        </button>
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            onDeleteConversation(c.id);
                          }}
                          className="opacity-0 group-hover:opacity-100 p-1.5 text-zinc-500 hover:text-red-400 transition shrink-0"
                          title="Delete chat"
                        >
                          <Trash2 className="w-3 h-3" />
                        </button>
                      </div>
                    ))
                  )}
                </div>
              )}
            </div>

            <button
              type="button"
              onClick={() => fitContext(chatNumCtx(selectedNode, activeTargetModel), true)}
              disabled={isStreaming || messages.length < 6}
              className="flex items-center space-x-1 px-1.5 py-1 rounded text-[11px] font-medium text-zinc-300 hover:text-white hover:bg-[#202026] border border-transparent hover:border-[#2a2a36] transition disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-zinc-300"
              title="Compact this chat. The work log keeps the finished steps and the next step."
            >
              <Shrink className="w-3.5 h-3.5 text-emerald-400" />
              <span>Compact</span>
            </button>
            <button
              type="button"
              onClick={handleNewChatClick}
              className="flex items-center space-x-1 px-1.5 py-1 rounded text-[11px] font-medium text-zinc-300 hover:text-white hover:bg-[#202026] border border-transparent hover:border-[#2a2a36] transition"
              title="New chat (Ctrl+L)"
            >
              <Plus className="w-3.5 h-3.5 text-indigo-400" />
              <span>New</span>
            </button>
          </div>
        </div>

      </div>

      {/* Messages Stream */}
      <div className="flex-1 p-3 overflow-y-auto space-y-3.5 select-text">
        {messages.length === 0 ? (
          <div className="h-full flex flex-col items-center justify-center text-center p-4 text-zinc-500 select-none">
            <MessageSquarePlus className="w-8 h-8 text-indigo-400/60 mb-2" />
            <p className="text-xs font-semibold text-zinc-200">{currentAgent.name}</p>
            <p className="text-[11px] text-zinc-500 mt-1">{currentAgent.role}</p>
            <p className="text-[10px] text-zinc-500 mt-2">
              New chat — ask anything, or press <kbd className="px-1 py-0.5 bg-[#22222a] rounded border border-[#333] font-mono">Ctrl+L</kbd>
            </p>

            <div className="mt-4 p-3 bg-[#18181d] rounded-xl border border-[#272732] text-[10px] text-zinc-400 text-left space-y-1.5 w-full">
              <div className="flex items-center space-x-1.5">
                <Zap className="w-3.5 h-3.5 text-amber-400 shrink-0" />
                <span>
                  <b>Active Target:</b>{' '}
                  {selectedNode && activeTargetModel
                    ? <>{selectedNode.name} → <code className="text-indigo-300">{activeTargetModel}</code> {benchmarkStat ? `(~${benchmarkStat.evalTokPerSec} tok/s)` : ''}</>
                    : <span className="text-amber-400">none — enable a model on this node</span>}
                </span>
              </div>
              <div className="flex items-center space-x-1.5">
                <Share2 className="w-3.5 h-3.5 text-emerald-400 shrink-0" />
                <span>
                  <b>Lead Architect:</b>{' '}
                  {conductorInfo
                    ? <>{conductorInfo.node.name} (<code className="text-emerald-300">{conductorInfo.model}</code> @ ~{conductorInfo.tokPerSec} tok/s{conductorInfo.usedFrontierBackup ? ' · frontier backup' : ' · local-first'}) locks the shared contract, then workers fan out by live tok/s</>
                    : <span className="text-zinc-500">unavailable until a node is online</span>}
                </span>
              </div>
            </div>
          </div>
        ) : (
          messages.map(msg => (
            <div
              key={msg.id}
              className={`flex flex-col ${msg.role === 'user' ? 'items-end' : 'items-start'}`}
            >
              {/* Message Header */}
              <div className="flex items-center space-x-1.5 text-[10px] text-zinc-500 mb-1 px-1">
                <span>
                  {msg.role === 'user'
                    ? 'You'
                    : (() => {
                        const msgAgent =
                          agents.find(a => a.id === msg.agentId) ||
                          agents.find(a => a.handle === msg.personaHandle) ||
                          currentAgent;
                        return msg.endpointName
                          ? `${msgAgent.name} (${msg.endpointName})`
                          : msgAgent.name;
                      })()}
                </span>
                <span>•</span>
                <span>{msg.timestamp}</span>
                {msg.personaHandle && msg.role === 'assistant' && (
                  <span className="text-amber-300/90 font-mono bg-amber-950/30 px-1 rounded text-[9px]">
                    @{msg.personaHandle}
                  </span>
                )}
                {msg.model && (
                  <span className="text-indigo-400 font-mono bg-indigo-950/40 px-1 rounded text-[9px]">
                    {msg.model}
                  </span>
                )}
                {msg.stats?.tokensPerSec && (
                  <span className="text-amber-400 font-mono text-[9px]">
                    ⚡ {msg.stats.tokensPerSec} tok/s
                  </span>
                )}
              </div>

              {/* Message Content */}
              <div
                className={`max-w-[95%] rounded-lg p-3 text-xs leading-relaxed ${
                  msg.role === 'user'
                    ? 'bg-indigo-600 text-white rounded-br-none shadow'
                    : 'bg-[#1e1e24] text-zinc-200 border border-[#2b2b36] rounded-bl-none'
                }`}
              >
                {/* Parallel Pipeline Grid if present */}
                {msg.pipelineSteps && msg.pipelineSteps.length > 0 && (
                  <div className="space-y-2.5 mb-3">
                    <div className="text-[11px] font-bold text-amber-300 flex items-center space-x-1.5">
                      <Share2 className="w-3.5 h-3.5" />
                      <span>Distributed Multi-Node File Generation:</span>
                    </div>

                    <div className="space-y-2">
                      {msg.pipelineSteps.map((step, sIdx) => (
                        <div
                          key={`${step.nodeId}-${step.targetFile || sIdx}`}
                          className="bg-[#121215] border border-[#282834] rounded-lg p-2.5 text-[11px]"
                        >
                          <div className="flex items-center justify-between font-mono text-[10px] mb-1">
                            <span className="text-indigo-300 font-bold truncate">{step.nodeName}</span>
                            <span className={`shrink-0 ml-2 ${
                              step.status === 'completed'
                                ? 'text-emerald-400'
                                : step.status === 'failed'
                                  ? 'text-red-400'
                                  : step.status === 'pending'
                                    ? 'text-zinc-500'
                                    : 'text-amber-400 animate-pulse'
                            }`}>
                              {step.status} {step.stats ? `(${step.stats.tokensPerSec} t/s)` : ''}
                            </span>
                          </div>
                          <div className="text-[9px] text-zinc-500 font-mono mb-1">{step.role}</div>
                          <div className="text-zinc-300 whitespace-pre-wrap max-h-36 overflow-y-auto font-mono text-[10px]">
                            {step.content || 'Awaiting computation...'}
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {/* Attached screenshots */}
                {msg.images && msg.images.length > 0 && (
                  <div className={`flex flex-wrap gap-1.5 ${msg.display ? 'mb-2' : ''}`}>
                    {msg.images.map((src, i) => (
                      <img
                        key={`${msg.id}-img-${i}`}
                        src={src}
                        alt={`Attachment ${i + 1}`}
                        className="max-h-36 max-w-full rounded border border-white/20 object-contain bg-black/20"
                      />
                    ))}
                  </div>
                )}

                {/* Display standard text */}
                {!msg.pipelineSteps && msg.display && (
                  <div className="whitespace-pre-wrap">{msg.display}</div>
                )}

                {msg.notice && msg.role === 'assistant' && !msg.display?.includes(msg.notice) && (
                  <div className="mb-2 text-[10px] text-emerald-300/90 font-medium">{msg.notice}</div>
                )}

                {/* Planner option buttons — never while a plan/task list is still running */}
                {msg.planOptions &&
                  msg.planOptions.length > 0 &&
                  !isPlanActive(plannerPlanView) &&
                  !hasOpenTasks(executionQueueRef.current) &&
                  !msg.selectedPlanOptionId && (
                  <PlanOptionsCard
                    options={msg.planOptions}
                    selectedId={msg.selectedPlanOptionId}
                    disabled={isStreaming}
                    onSelect={opt => handleSelectPlanOption(opt, msg)}
                  />
                )}

                {/* Reviewer fix plan — never Apply writes from reviewer */}
                {msg.reviewPlan && !msg.stepVerdict && (
                  <ReviewPlanCard
                    plan={msg.reviewPlan}
                    sent={!!msg.reviewSentToCoder}
                    disabled={isStreaming}
                    onSendToPlanner={() => sendReviewPlanToPlanner(msg)}
                    onContinue={
                      msg.reviewNeedsContinue
                        ? () => continueAfterCleanReview(msg)
                        : undefined
                    }
                  />
                )}

                {/* Planner step Yay/Nay */}
                {msg.stepVerdict && (
                  <StepVerdictCard
                    stepId={msg.stepVerdict.stepId}
                    stepTitle={msg.stepVerdict.stepTitle}
                    result={msg.stepVerdict.result}
                    notes={msg.stepVerdict.notes}
                    sent={!!msg.stepVerdictApplied}
                    disabled={isStreaming}
                    needsConfirm={!!msg.stepVerdictNeedsConfirm}
                    onApply={() => applyStepVerdictAndContinue(msg)}
                  />
                )}

                {/* Tool Invocations (hide write/edit Apply UI for reviewer messages) */}
                {(() => {
                  const isReviewerMsg =
                    msg.personaHandle === 'reviewer' || !!msg.reviewPlan || !!msg.stepVerdict;
                  const tools = isReviewerMsg
                    ? (msg.toolCalls || []).filter(t =>
                        ['read_file', 'list_dir', 'search', 'read_terminal'].includes(t.name)
                      )
                    : msg.toolCalls || [];
                  if (!tools.length) return null;
                  const showApply =
                    !isReviewerMsg && tools.some(t => t.status !== 'done');
                  return (
                    <div className="mt-3 space-y-2 pt-2 border-t border-[#31313e]">
                      <div className="flex items-center justify-between">
                        <div className="text-[10px] uppercase font-bold text-indigo-300 tracking-wider">
                          {isReviewerMsg
                            ? `Exploration (${tools.length}):`
                            : `Workspace Actions (${tools.length}):`}
                        </div>
                        {showApply && (
                          <button
                            onClick={() => handleApplyAllTools(msg)}
                            className="flex items-center space-x-1 text-[10px] font-sans font-medium px-2 py-0.5 bg-indigo-600/30 hover:bg-indigo-600 text-indigo-200 hover:text-white border border-indigo-500/40 rounded transition"
                            title="Apply all proposed changes to workspace"
                          >
                            <Sparkles className="w-2.5 h-2.5 text-indigo-300" />
                            <span>Apply All</span>
                          </button>
                        )}
                      </div>
                      {tools.map(tool => (
                        <ToolActionCard
                          key={tool.id}
                          tool={tool}
                          workspacePath={workspacePath}
                          onApplyFileWrite={onApplyFileWrite}
                          onExecuteToolCommand={onExecuteToolCommand}
                          onOpenFileInEditor={onOpenFileInEditor}
                          onRunSingleTool={runSingleTool}
                          hideApply={isReviewerMsg}
                        />
                      ))}
                    </div>
                  );
                })()}
              </div>
            </div>
          ))
        )}
        <div ref={chatBottomRef} />
      </div>

      {/* Input Composer */}
      <div className="p-3 border-t border-[#27272a] bg-[#121215]">
        {isStreaming && <ActivityIndicator label={activityLabel} />}
        {activeTab && (
          <div className="flex items-center justify-between mb-2 px-1 text-[11px] text-zinc-400">
            <label className="flex items-center space-x-1.5 cursor-pointer hover:text-zinc-200">
              <input
                type="checkbox"
                checked={includeActiveFile}
                onChange={(e) => setIncludeActiveFile(e.target.checked)}
                className="rounded border-[#31313e] bg-[#1e1e24] text-indigo-500"
              />
              <span className="flex items-center space-x-1 font-mono text-[10px] truncate max-w-[200px]">
                <Paperclip className="w-3 h-3 text-amber-400" />
                <span>Attach {activeTab.name}</span>
              </span>
              <HelpTip title="Attach active file">
                <p>When checked, the open editor tab’s contents are included with your next message so the agent can edit or explain that file without reading it first.</p>
                <p>Uncheck for general questions that should not depend on the current buffer.</p>
              </HelpTip>
            </label>
            <span className="text-[10px] text-zinc-500 font-mono">{activeTab.language}</span>
          </div>
        )}

        {pendingImages.length > 0 && (
          <div className="mb-2 flex flex-wrap items-center gap-2 px-1">
            {pendingImages.map((src, i) => (
              <div key={`pending-${i}`} className="relative group">
                <img
                  src={src}
                  alt={`Pending ${i + 1}`}
                  className="h-14 w-auto max-w-[120px] rounded border border-[#3a3a48] object-cover"
                />
                <button
                  type="button"
                  onClick={() => setPendingImages(prev => prev.filter((_, j) => j !== i))}
                  className="absolute -top-1.5 -right-1.5 p-0.5 rounded-full bg-zinc-800 border border-zinc-600 text-zinc-300 hover:text-white hover:bg-red-700"
                  title="Remove image"
                >
                  <X className="w-3 h-3" />
                </button>
              </div>
            ))}
            {!selectedSupportsVision && (
              <span className="text-[10px] text-amber-400/90 max-w-[180px] leading-snug">
                {activeTargetModel || 'This model'} may not read images — pick a vision model like gemma4.
              </span>
            )}
          </div>
        )}

        <form onSubmit={handleSendMessage} className="relative flex items-end gap-1.5">
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*"
            multiple
            className="hidden"
            onChange={async e => {
              await addImageFiles(e.target.files);
              e.target.value = '';
            }}
          />
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            disabled={isStreaming}
            className="shrink-0 p-2 mb-0.5 text-zinc-400 hover:text-indigo-300 hover:bg-[#1e1e24] rounded-md transition disabled:opacity-30"
            title="Attach screenshot or image"
          >
            <ImagePlus className="w-4 h-4" />
          </button>
          <div className="relative flex-1">
            <textarea
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onPaste={handlePaste}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  handleSendMessage();
                }
              }}
              placeholder={
                findPendingPlanMessage(messages)
                  ? 'Pick an option (click or type option 1)…'
                  : isPlannerSelected
                    ? 'Describe what you want — Planner will propose options…'
                    : isPipelineMode
                      ? 'Dispatch task in parallel across all GPUs...'
                      : selectedSupportsVision
                        ? `Ask ${currentAgent.name}… (Ctrl+V to paste a screenshot)`
                        : `Ask ${currentAgent.name}...`
              }
              rows={2}
              className="w-full bg-[#1a1a20] border border-[#2a2a34] focus:border-indigo-500 text-zinc-200 placeholder-zinc-500 text-xs rounded-lg p-2.5 pr-10 outline-none resize-none transition font-sans"
            />

            <div className="absolute right-2 bottom-2.5">
              {isStreaming ? (
                <button
                  type="button"
                  onClick={handleStop}
                  className="p-1.5 bg-red-600 hover:bg-red-500 text-white rounded-md transition shadow"
                  title="Stop Generation"
                >
                  <Square className="w-3.5 h-3.5" />
                </button>
              ) : (
                <button
                  type="submit"
                  disabled={!input.trim() && pendingImages.length === 0}
                  className="p-1.5 bg-indigo-600 hover:bg-indigo-500 disabled:opacity-30 text-white rounded-md transition shadow"
                >
                  <Send className="w-3.5 h-3.5" />
                </button>
              )}
            </div>
          </div>
        </form>
      </div>
      </div>

      {/* Inner split resize */}
      <div
        onMouseDown={() => setResizingControl(true)}
        title="Drag to resize Conductor column"
        className={`w-1 cursor-col-resize transition-colors shrink-0 ${
          resizingControl ? 'bg-indigo-500' : 'bg-[#22222a] hover:bg-indigo-500/60'
        }`}
      />

      {/* Right — Orchestration */}
      <div
        style={{ width: controlColWidth }}
        className="shrink-0 flex flex-col min-h-0 min-w-[220px] bg-[#121215] border-l border-[#27272a]"
      >
        <div className="p-2.5 border-b border-[#27272a] shrink-0 space-y-2">
          <div className="flex items-center justify-between gap-1">
            <div className="flex items-center gap-1.5 text-[10px] uppercase font-bold tracking-wider text-zinc-300">
              <Cpu className="w-3 h-3 text-indigo-400" />
              <span>Conductor</span>
            </div>
            <HelpTip title="Agent personas" align="right">
              <p>Left column is the conversation. This column is personas, the durable plan/task list, and routing.</p>
              <ul className="list-disc pl-3.5 space-y-1">
                <li><b className="text-zinc-300">coder</b> — build & edit files</li>
                <li><b className="text-zinc-300">planner</b> — options then locks steps/tasks</li>
                <li><b className="text-zinc-300">reviewer</b> — Yay/Nay per plan step</li>
                <li><b className="text-zinc-300">docs</b> — explanations / docs</li>
              </ul>
            </HelpTip>
          </div>
          <div className="flex flex-wrap gap-1">
            {agents.map(a => (
              <button
                key={a.id}
                onClick={() => onSelectAgent(a.id)}
                title={`${a.name}: ${a.role}`}
                className={`px-2 py-0.5 text-[11px] font-medium rounded transition ${
                  selectedAgentId === a.id
                    ? 'bg-indigo-600 text-white shadow-sm'
                    : 'text-zinc-400 hover:text-zinc-200 hover:bg-[#202026]'
                }`}
              >
                {a.handle}
              </button>
            ))}
          </div>
        </div>

        <div className="px-2.5 pt-2 space-y-1.5 shrink-0">
          {(progressLog.next || progressLog.done.length > 0) && (
            <div className="text-[10px] text-zinc-400 truncate" title={renderWorkLog(progressLog)}>
              <span className="text-emerald-300/90 font-medium">Next:</span> {progressLog.next || '—'}
              <span className="text-zinc-500"> · {progressLog.done.length} done</span>
            </div>
          )}
          {executingPlanNotice && (
            <div className="flex items-center justify-between gap-2 px-2 py-1.5 rounded-md bg-emerald-600/15 border border-emerald-500/30 text-[10px] text-emerald-200">
              <span className="font-medium truncate">{executingPlanNotice}</span>
              <button
                type="button"
                className="shrink-0 text-zinc-400 hover:text-zinc-200"
                onClick={() => setExecutingPlanNotice(null)}
                title="Dismiss"
              >
                <X className="w-3 h-3" />
              </button>
            </div>
          )}
        </div>

        <div className="flex-1 min-h-0 flex flex-col px-2.5 py-2">
          {plannerPlanView && plannerPlanView.steps.length > 0 ? (
            <PlannerPlanPanel plan={plannerPlanView} />
          ) : (
            <div className="rounded-md border border-dashed border-[#2a2a36] bg-[#0e0e12] px-2.5 py-3 text-[10px] text-zinc-500 leading-relaxed">
              No active plan — pick a Planner option to lock steps and tasks here.
            </div>
          )}
        </div>

        <div className="p-2.5 border-t border-[#27272a] space-y-2 shrink-0 text-[10px]">
          <div className="grid grid-cols-1 gap-2">
            <div className="flex flex-col space-y-1">
              <span className="text-zinc-500 font-medium flex items-center space-x-1">
                {isFrontier ? <Cloud className="w-3 h-3 text-sky-400 shrink-0" /> : <Cpu className="w-3 h-3 text-emerald-400 shrink-0" />}
                <span>Hardware Target</span>
              </span>
              <select
                value={nodes.some(n => n.id === targetNodeId) ? targetNodeId : ''}
                onChange={(e) => {
                  const newNodeId = e.target.value;
                  setTargetNodeId(newNodeId);
                  setAutoSelectEndpoint(false);
                  const nextNode = nodes.find(n => n.id === newNodeId);
                  if (nextNode) setTargetModel(getPreferredModelForNode(nextNode));
                }}
                disabled={nodes.length === 0}
                className="bg-[#1c1c24] border border-[#2a2a36] text-zinc-200 rounded px-2 py-1 outline-none text-[11px] truncate disabled:opacity-50"
              >
                {nodes.length === 0 ? (
                  <option value="">No endpoints — open Hardware Settings</option>
                ) : (
                  nodes.map(n => (
                    <option key={n.id} value={n.id} disabled={!n.online}>
                      {n.name} {n.online ? `(${n.latency}ms)` : '(Offline)'}
                    </option>
                  ))
                )}
              </select>
            </div>
            <div className="flex flex-col space-y-1">
              <span className="text-zinc-500 font-medium flex items-center justify-between">
                <span>Node Model</span>
                {benchmarkStat && (
                  <span className="text-amber-400 font-mono text-[9px] flex items-center space-x-0.5">
                    <Zap className="w-2.5 h-2.5" />
                    <span>{benchmarkStat.evalTokPerSec} t/s</span>
                  </span>
                )}
              </span>
              <select
                value={activeTargetModel}
                onChange={(e) => {
                  const newModel = e.target.value;
                  if (!newModel) return;
                  setTargetModel(newModel);
                  if (selectedNode) onSelectNodeModel?.(selectedNode.id, newModel);
                }}
                disabled={effectiveModels.length === 0}
                className="bg-[#1c1c24] border border-[#2a2a36] text-zinc-200 rounded px-2 py-1 outline-none text-[11px] truncate disabled:opacity-50"
              >
                {effectiveModels.length === 0 ? (
                  <option value="">
                    {!selectedNode
                      ? 'Add an endpoint in Hardware Settings'
                      : selectedNode.online
                        ? 'No models installed — pull in Hardware Settings'
                        : 'Node offline / no models'}
                  </option>
                ) : (
                  effectiveModels.map(m => (
                    <option key={m} value={m}>
                      {m}
                    </option>
                  ))
                )}
              </select>
              {selectedSupportsThink && onToggleModelThinking && selectedNode && activeTargetModel && (
                <button
                  type="button"
                  onClick={() => onToggleModelThinking(selectedNode.id, activeTargetModel, !selectedThinkOn)}
                  className={`w-full flex items-center justify-center space-x-1.5 px-2 py-1 rounded border text-[10px] font-medium transition ${
                    selectedThinkOn
                      ? 'bg-violet-600/25 border-violet-500/40 text-violet-200'
                      : 'bg-[#18181d] border-[#2a2a34] text-zinc-400 hover:text-zinc-200'
                  }`}
                  title="Qwen3-style thinking: ON = deeper/slower, OFF = faster direct answers"
                >
                  <Brain className={`w-3 h-3 ${selectedThinkOn ? 'text-violet-300' : 'text-zinc-500'}`} />
                  <span>{thinkingToggleLabel(!!selectedThinkOn)}</span>
                </button>
              )}
            </div>
          </div>

          <button
            onClick={() => setIsPipelineMode(!isPipelineMode)}
            className={`w-full flex items-center justify-center space-x-1.5 px-2 py-1 rounded border transition ${
              isPipelineMode
                ? 'bg-amber-500/20 border-amber-500/40 text-amber-300 font-semibold'
                : 'bg-[#18181d] border-[#2a2a34] text-zinc-400 hover:text-zinc-200'
            }`}
            title={isPipelineMode ? 'Conductor Swarm is ON' : 'Enable multi-GPU file distribution'}
          >
            <Share2 className="w-3 h-3 text-amber-400 shrink-0" />
            <span className="truncate">
              Swarm ({onlineLocalNodes.length} local
              {nodes.filter(n => n.online && isFrontierNode(n) && getEnabledModelsForNode(n).length > 0).length
                ? ' + frontier'
                : ''}
              )
            </span>
          </button>

          <div className="flex flex-col gap-1.5 text-zinc-400">
            <label className="flex items-center space-x-1.5 cursor-pointer hover:text-zinc-200">
              <input
                type="checkbox"
                checked={autoSelectEndpoint}
                onChange={(e) => setAutoSelectEndpoint(e.target.checked)}
                className="rounded border-[#31313e] bg-[#1e1e24] text-indigo-500"
              />
              <span>Auto-Node</span>
            </label>
            <label className="flex items-center space-x-1.5 cursor-pointer hover:text-zinc-200">
              <input
                type="checkbox"
                checked={autoApplyWrites}
                onChange={(e) => {
                  autoApplyWritesRef.current = e.target.checked;
                  setAutoApplyWrites(e.target.checked);
                }}
                className="rounded border-[#31313e] bg-[#1e1e24] text-indigo-500"
              />
              <span>Auto-apply</span>
            </label>
            <label className="flex items-center space-x-1.5 cursor-pointer hover:text-zinc-200">
              <input
                type="checkbox"
                checked={autoReview}
                onChange={(e) => {
                  autoReviewRef.current = e.target.checked;
                  setAutoReview(e.target.checked);
                }}
                className="rounded border-[#31313e] bg-[#1e1e24] text-indigo-500"
              />
              <span>Auto-review</span>
            </label>
          </div>
        </div>
      </div>
    </div>
  );
};
