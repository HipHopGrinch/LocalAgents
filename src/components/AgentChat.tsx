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
  queueAssignmentsByGpu,
  type SwarmAssignment,
  type SwarmManifest
} from '../lib/swarmContract';
import {
  MAX_TOOL_CONTINUATIONS,
  MAX_COMMAND_FIX_ATTEMPTS,
  autoApplyWritableTools,
  buildContinuationUserPrompt,
  collectFeedbackTools,
  executeTool,
  failedCommandSignatures,
  historyForModel,
  runCommandTools,
  runAuxTools,
  runReadOnlyTools,
  shouldContinueFromTools
} from '../lib/agentLoop';
import { streamChat } from '../lib/ollamaClient';
import { ToolActionCard } from './agent/ToolActionCard';
import { PlanOptionsCard } from './agent/PlanOptionsCard';
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
  pickFreeTierAssist,
  pickPaidFrontier,
  reviewNeedsAssist,
  tailForAssist,
  type FreeTierUsage
} from '../lib/freeTierAssist';
import { isRepeatStop, nextStuckStage, stuckKey, type StuckStage } from '../lib/stuckEscalation';
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
  formatApprovedPlanContext,
  formatApprovedPlanForSwarm,
  matchPlanOption,
  parsePlanOptions,
  stripPlanOptionMarkup
} from '../lib/planOptions';
import {
  buildContinuationReviewPrompt,
  collectWrittenPaths,
  CONTINUATION_REVIEW_SYSTEM,
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
  onConversationPatch?: (patch: Partial<Pick<ChatConversation, 'approvedPlan' | 'agentId'>>) => void;
  onNewChat: () => void;
  onSelectConversation: (id: string) => void;
  onDeleteConversation: (id: string) => void;
  /** Persist think on/off for a model on a node */
  onToggleModelThinking?: (nodeId: string, modelName: string, enabled: boolean) => void;
  searxngUrl?: string;
}

export const AgentChat: React.FC<AgentChatProps> = ({
  agents,
  selectedAgentId,
  onSelectAgent,
  nodes,
  activeTab,
  workspacePath,
  workspaceFiles,
  width = 420,
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
  searxngUrl = ''
}) => {
  const currentAgent = agents.find(a => a.id === selectedAgentId) || agents[0];
  const coderAgent = agents.find(a => a.handle === 'coder' || a.id === 'coder') || agents[0];
  const isPlannerSelected =
    currentAgent.handle === 'planner' || currentAgent.id === 'planner';

  // Routing states
  const [targetNodeId, setTargetNodeId] = useState<string>(currentAgent.endpointId);
  const [targetModel, setTargetModel] = useState<string>(currentAgent.model);
  const [autoSelectEndpoint, setAutoSelectEndpoint] = useState<boolean>(true);
  const [includeActiveFile, setIncludeActiveFile] = useState(true);
  const [isPipelineMode, setIsPipelineMode] = useState(false);
  const [autoApplyWrites, setAutoApplyWrites] = useState<boolean>(currentAgent.autoApproveWrites ?? true);
  const autoApplyWritesRef = useRef(currentAgent.autoApproveWrites ?? true);

  const [input, setInput] = useState('');
  const [pendingImages, setPendingImages] = useState<string[]>([]);
  const [messages, setMessages] = useState<ChatMessage[]>(conversation?.messages || []);
  const [isStreaming, setIsStreaming] = useState(false);
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
  const stopRequestedRef = useRef(false);
  const freeTierUsageRef = useRef<Record<string, FreeTierUsage>>({});
  const stuckRef = useRef<{ key: string; stage: StuckStage }>({ key: '', stage: 'none' });

  type LoopBudget = {
    depth: number;
    commandFixAttempts: number;
    prevFailedCmdSigs: string[];
    writeFixAttempts: number;
  };

  const resetAgentLoopBudget = () => {
    continuationDepthRef.current = 0;
    commandFixAttemptsRef.current = 0;
    writeFixAttemptsRef.current = 0;
    prevFailedCmdSigsRef.current = [];
  };

  const continueDecisionOpts = (budget?: LoopBudget) => ({
    commandFixAttempts: budget ? budget.commandFixAttempts : commandFixAttemptsRef.current,
    prevFailedCmdSigs: budget ? budget.prevFailedCmdSigs : prevFailedCmdSigsRef.current,
    writeFixAttempts: budget ? budget.writeFixAttempts : writeFixAttemptsRef.current
  });

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
      setExecutingPlanNotice(null);
      setInput('');
      setPendingImages([]);
      setHistoryOpen(false);
      stuckRef.current = { key: '', stage: 'none' };
    }
  }, [conversation?.id]);

  useEffect(() => {
    if (conversation?.id === conversationIdRef.current) {
      approvedPlanRef.current = conversation?.approvedPlan ?? null;
    }
  }, [conversation?.approvedPlan, conversation?.id]);

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

  /** One short frontier reply. Free-tier calls count against the daily cap. */
  const requestAssistBrief = async (
    target: { node: EndpointNode; model: string },
    purpose: string,
    payload: string,
    countFreeTier: boolean
  ): Promise<string | null> => {
    if (stopRequestedRef.current) return null;
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
    const result = await handle.done;
    if (result.aborted || stopRequestedRef.current) return null;
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
    }
  ) => {
    const budget = opts?.budget;
    const depth = budget ? budget.depth : continuationDepthRef.current;
    if (depth >= MAX_TOOL_CONTINUATIONS) return;

    const feedbackTools = collectFeedbackTools(originMsg.toolCalls || []);
    if (feedbackTools.length === 0) return;
    if (!shouldContinueFromTools(originMsg.toolCalls || [], continueDecisionOpts(budget))) return;

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

    if (budget) budget.depth += 1;
    else continuationDepthRef.current += 1;
    const routeNode = opts?.node || selectedNode;
    if (!routeNode) return;
    const routeModel = opts?.model || activeTargetModel;
    const followUpId = `followup-${Date.now()}`;
    const planModeContinueEarly =
      currentAgent.handle === 'planner' ||
      currentAgent.id === 'planner' ||
      originMsg.personaHandle === 'planner';
    const followUpMsg: ChatMessage = {
      id: followUpId,
      role: 'assistant',
      raw: '',
      display: cmdFailed
        ? 'Command failed — one fix attempt from terminal output...'
        : planModeContinueEarly
          ? 'Explored the workspace. Drafting the plan and options...'
          : 'Analyzed project files. Now generating implementation...',
      agentId: currentAgent.id,
      personaHandle: originMsg.personaHandle || currentAgent.handle,
      endpointId: routeNode.id,
      endpointName: routeNode.name,
      model: routeModel,
      timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
      toolCalls: []
    };

    setMessages(prev => [...prev, followUpMsg]);
    setIsStreaming(true);

    try {
      const continuationPrompt = buildContinuationUserPrompt(feedbackTools, {
        // True only on a 2nd+ command-fix continue (when MAX_COMMAND_FIX_ATTEMPTS > 1)
        finalCommandAttempt: priorFixAttempts > 0
      });
      const planModeContinue =
        currentAgent.handle === 'planner' ||
        currentAgent.id === 'planner' ||
        originMsg.personaHandle === 'planner';
      fitContext(chatNumCtx(routeNode, routeModel));
      const systemPrompt = buildSystemPrompt(currentAgent, workspacePath, workspaceOverview, {
        planMode: planModeContinue,
        approvedPlan: planModeContinue ? null : approvedPlanRef.current,
        progressLog: progressForPrompt()
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
            : continuationPrompt
        }
      ];

      const body = withThink({
        model: routeModel,
        messages: conversationPayload,
        options: {
          temperature: currentAgent.temperature,
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
          const liveOptions = planModeContinue ? parsePlanOptions(content) : [];
          setMessages(prev => prev.map(m => {
            if (m.id === followUpId) {
              return {
                ...m,
                raw: content,
                display: stripPlanOptionMarkup(parsed.display || content),
                thinking: parsed.thinking || thinking,
                toolCalls: planModeContinue
                  ? parsed.toolCalls.filter(t =>
                      ['read_file', 'list_dir', 'search', 'read_terminal'].includes(t.name)
                    )
                  : parsed.toolCalls,
                ...(liveOptions.length >= 2
                  ? {
                      planOptions: liveOptions,
                      planSummary: buildPlanSummary(content, liveOptions)
                    }
                  : {})
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
      const finished = planModeContinue
        ? result.content
        : await finishTruncatedWrites(routeNode, routeModel, result.content, result.stats?.doneReason);
      let finalParsed = parseResponse(finished, followUpId, false, {
        expectedFilePath: opts?.expectedFilePath,
        createIntent: planModeContinue ? false : (opts?.createIntent ?? true)
      });

      let tools = finalParsed.toolCalls;
      if (planModeContinue) {
        tools = tools.filter(t =>
          ['read_file', 'list_dir', 'search', 'read_terminal'].includes(t.name)
        );
      }
      const readPass = await runReadOnlyTools(tools, toolDeps);
      tools = readPass.tools;

      if (!planModeContinue && autoApplyWritesRef.current) {
        tools = await autoApplyWritableTools(tools, toolDeps);
        tools = await runAuxTools(tools, toolDeps);
        const cmdPass = await runCommandTools(tools, toolDeps);
        tools = cmdPass.tools;
        updateProgress(log => noteSavedFiles(log, tools));
      }

      const stillFailing =
        failedCommandSignatures(tools).length > 0 &&
        !shouldContinueFromTools(tools, continueDecisionOpts(budget));
      const planOptions = planModeContinue ? parsePlanOptions(finished) : [];
      const displayBase = stripPlanOptionMarkup(finalParsed.display || finished);
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
          : {})
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
        progressLog: progressForPrompt()
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
          writeFixAttempts: 0
        };
        if (shouldContinueFromTools(tools, continueDecisionOpts(workerBudget))) {
          const origin: ChatMessage = {
            id: `${agentMsgId}-worker-${idx}`,
            role: 'assistant',
            raw: finished,
            display: '',
            toolCalls: tools,
            timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
          };
          await continueWithToolResults(origin, {
            expectedFilePath,
            createIntent: true,
            node,
            model,
            budget: workerBudget
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
        patchPipelineMsg(m => {
          if (!m.pipelineSteps) return m;
          const updatedSteps = [...m.pipelineSteps];
          if (updatedSteps[idx]) {
            updatedSteps[idx] = {
              ...updatedSteps[idx],
              status: 'failed',
              content: `Failed on ${node.name}: ${workerErr?.message || workerErr}`
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
        const architectPrompt = buildLeadArchitectPrompt(
          swarmTaskText,
          workspaceOverview,
          snippets,
          lockedPlan ? formatApprovedPlanForSwarm(lockedPlan) : null,
          progressForPrompt() || null
        );
        const architectBody: Record<string, unknown> = {
          model: architect.model,
          messages: [
            {
              role: 'system',
              content:
                'You are the Lead Architect (@coder). Respond ONLY with a valid JSON object for the Swarm manifest. No markdown outside JSON.'
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

      // ── Pass 2: Fan Out Parallel File Workers ──
      const assignments = assignSwarmTasksToCluster(manifest.tasks, nodes);
      if (!assignments.length) {
        patchPipelineMsg({
          display: '⚠️ No worker assignments produced. Check Hardware Settings for online nodes.'
        });
        return;
      }

      const gpuQueues = queueAssignmentsByGpu(assignments);
      const queueHeadSteps = new Set(gpuQueues.map(queue => queue[0].stepIdx));
      const localCount = assignments.filter(a => !isFrontierNode(a.node)).length;
      const frontierCount = assignments.length - localCount;
      const siblingSummary = assignments
        .map(
          a =>
            `- ${a.task.filePath} (${a.task.complexity}${a.task.role ? `, ${a.task.role}` : ''}): ${a.task.instructions.slice(0, 120)}`
        )
        .join('\n');

      const initialSteps: PipelineStep[] = [
        {
          nodeId: architect.node.id,
          nodeName: `${architect.node.name} → ${manifest.contractFile}`,
          modelName: architect.model,
          targetFile: manifest.contractFile,
          agentHandle: 'coder',
          role: `Lead Architect · contract${architect.usedFrontierBackup ? ' (frontier)' : ' (local)'}`,
          status: 'completed',
          content: `Locked shared contract (${manifest.tasks.length} tasks)`,
          toolCalls: []
        },
        ...assignments.map(({ task, node, model, skippedReason }, i) => {
          const stepIdx = i + 1;
          const offline = !!(skippedReason && !node.online);
          const isHead = queueHeadSteps.has(stepIdx);
          const status: PipelineStep['status'] = offline ? 'failed' : isHead ? 'running' : 'pending';
          return {
            nodeId: node.id,
            nodeName: `${node.name} → ${task.filePath}`,
            modelName: model,
            targetFile: task.filePath,
            agentHandle: 'coder' as const,
            role: `${task.role || task.preferredRole} · ${model}${
              isFrontierNode(node) ? ' (frontier)' : ' (local)'
            }${skippedReason ? ` — ${skippedReason}` : ''}`,
            status,
            content: offline
              ? `Skipped: ${skippedReason}`
              : isHead
                ? `Generating ${task.filePath} on ${node.name} using ${model}…`
                : `Queued on ${node.name} — one model at a time (${model})`,
            toolCalls: [] as PipelineStep['toolCalls']
          };
        })
      ];

      patchPipelineMsg({
        display:
          frontierCount > 0 && localCount === 0
            ? `⚡ Pass 2 — dispatched ${assignments.length} files via frontier backup (contract locked):`
            : `⚡ Pass 2 — ${assignments.length} files across ${gpuQueues.length} GPU${
                gpuQueues.length === 1 ? '' : 's'
              } (${localCount} local worker${localCount === 1 ? '' : 's'}${
                frontierCount ? ` + ${frontierCount} frontier` : ''
              }). Each machine runs one file at a time:`,
        pipelineSteps: initialSteps
      });

      await Promise.allSettled(
        gpuQueues.map(async queue => {
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
                  content: `Generating ${assignment.task.filePath} on ${assignment.node.name} using ${assignment.model}…`
                };
                return { ...m, pipelineSteps: updatedSteps };
              });
            }
            const current = await readWorkspaceRel(assignment.task.filePath);
            const workerLog = progressForPrompt();
            const workerPrompt = `${buildSwarmWorkerPrompt({
              task: assignment.task,
              contractFile: manifest.contractFile,
              contractCode: manifest.contractCode,
              siblingSummary,
              currentFileContent: current,
              userPrompt: fullPrompt
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
                    tscErrors: errors
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

  /** Single-node chat turn with optional plan mode or locked approved plan. */
  const runSingleNodeTurn = async (opts: {
    userText: string;
    fullPrompt: string;
    attachedImages?: string[];
    agent: AgentPersona;
    planMode?: boolean;
    approvedPlan?: ApprovedPlan | null;
    userMsgExtra?: Partial<ChatMessage>;
    skipUserAppend?: boolean;
    notice?: string;
    /** Keep a fix on the review model instead of the worker that wrote the files. */
    pinRoute?: { node: EndpointNode; model: string };
  }) => {
    const {
      userText,
      fullPrompt,
      attachedImages = [],
      agent,
      planMode,
      approvedPlan,
      userMsgExtra,
      skipUserAppend,
      notice,
      pinRoute
    } = opts;

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

    const createIntent = !planMode && looksLikeCreateIntent(userText);
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

    try {
      fitContext(chatNumCtx(routedNode, routedModel));
      const systemPrompt = buildSystemPrompt(agent, workspacePath, workspaceOverview, {
        planMode: !!planMode,
        approvedPlan: planMode ? null : approvedPlan,
        progressLog: progressForPrompt()
      });
      const actionableUserPrompt = planMode
        ? `${fullPrompt}\n\n[PLANNER DIRECTIVE: Analyze intent, propose a concrete plan, and end with 2–4 options in a <plan_options> block. Do NOT write deliverable files yet.]`
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
      if (stopRequestedRef.current) return;

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
          const displayBase = stripPlanOptionMarkup(parsed.display || content);
          const liveOptions = planMode ? parsePlanOptions(content) : [];
          setMessages(prev =>
            prev.map(m => {
              if (m.id !== agentMsgId) return m;
              return {
                ...m,
                raw: content,
                display: displayBase,
                thinking: parsed.thinking || thinking,
                toolCalls: planMode
                  ? parsed.toolCalls.filter(t =>
                      ['read_file', 'list_dir', 'search', 'read_terminal'].includes(t.name)
                    )
                  : parsed.toolCalls,
                ...(liveOptions.length >= 2
                  ? { planOptions: liveOptions, planSummary: buildPlanSummary(content, liveOptions) }
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
      const finished = planMode
        ? result.content
        : await finishTruncatedWrites(routedNode, routedModel, result.content, result.stats?.doneReason);
      const finalParsed = parseResponse(finished, agentMsgId, false, { createIntent });

      let tools = finalParsed.toolCalls;
      if (planMode) {
        // Planner: explore only — drop accidental write/edit/run tools
        tools = tools.filter(t =>
          ['read_file', 'list_dir', 'search', 'read_terminal'].includes(t.name)
        );
      }

      const readPass = await runReadOnlyTools(tools, toolDeps);
      tools = readPass.tools;

      if (!planMode && autoApplyWritesRef.current) {
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

      const options = planMode ? parsePlanOptions(finished) : [];
      const displayText = stripPlanOptionMarkup(finalParsed.display || finished);

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
        ...(notice ? { notice } : {})
      };

      setMessages(prev => prev.map(m => (m.id === agentMsgId ? origin : m)));

      if (!planMode && shouldContinueFromTools(tools, continueDecisionOpts())) {
        await continueWithToolResults(origin, { createIntent, node: routedNode, model: routedModel });
      } else if (planMode && shouldContinueFromTools(tools, continueDecisionOpts())) {
        // Allow planner read-tool continuations (still in plan mode via currentAgent)
        await continueWithToolResults(origin, { createIntent: false, node: routedNode, model: routedModel });
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
  };

  /**
   * After a coding step, the largest enabled local model checks the workspace.
   * It may patch bugs in the files just written. A fix to those files stays on
   * this model. A new feature goes through the normal local route.
   */
  const reviewAndAdvance = async (depth: number, previousTask = ''): Promise<void> => {
    if (stopRequestedRef.current) return;

    const recent = messagesRef.current;
    let userIdx = recent.length - 1;
    while (userIdx >= 0 && recent[userIdx].role !== 'user') userIdx -= 1;
    const sinceUser = recent.slice(Math.max(0, userIdx));
    const didWork =
      !!approvedPlanRef.current ||
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
    if (!target) return;
    const { node, model } = target;
    const touchedPaths = collectWrittenPaths(recent);

    const reviewer = agents.find(a => a.handle === 'reviewer' || a.id === 'reviewer') || agents[0];
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
    let userContent = buildContinuationReviewPrompt({
      approvedPlanText: planText,
      recentTranscript: transcript,
      workspaceOverview,
      workLog: progressForPrompt(),
      writtenPaths: touchedPaths,
      capped
    });

    const agentMsgId = `review-${Date.now()}`;
    const stamp = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    setExecutingPlanNotice(capped ? 'Out of automatic steps — asking what to do next' : 'Checking what is left…');
    setMessages(prev => [
      ...prev,
      {
        id: agentMsgId,
        role: 'assistant',
        raw: '',
        display: '',
        agentId: reviewer.id,
        personaHandle: reviewer.handle,
        endpointId: node.id,
        endpointName: node.name,
        model,
        timestamp: stamp,
        notice: `Checking the work on ${node.name}`,
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
              { role: 'system', content: CONTINUATION_REVIEW_SYSTEM },
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

      if (touchedPaths.length > 0 && window.electronAPI?.execTool) {
        const chunks: string[] = [];
        let chars = 0;
        for (const path of touchedPaths.slice(0, 8)) {
          if (chars > 160000) break;
          try {
            const res = await window.electronAPI.execTool(workspacePath, 'read_file', { path });
            const body = (res.content || '').slice(0, 40000);
            if (!body) continue;
            chunks.push(`FILE ${path}\n${body}`);
            chars += body.length;
          } catch {
            /* a missing file stays a local review */
          }
        }
        const bundle = chunks.join('\n\n');
        if (bundle && reviewNeedsAssist(chunks.length, bundle.length, chatNumCtx(node, model))) {
          try {
            const brief = await requestFreeTierBrief(
              'Review these files for bugs the local model should patch. List only real defects.',
              bundle
            );
            if (brief) {
              userContent += `\n\nFree-tier review brief (patch these if they match the files):\n${brief}`;
              setExecutingPlanNotice(`Asked the free-tier key for a short review of ${chunks.length} files.`);
            }
          } catch (err: any) {
            window.electronAPI?.writeLog?.('warn', `free-tier review: ${err?.message || err}`);
          }
        }
      }

      const first = await askModel(userContent, []);
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
          .join('\n\n')}\n\nYou may emit <edit_file> patches for bugs in the files you just read. Do not start a new feature. Do not rewrite a whole file when a search/replace will do. Then end with exactly one <next_step> block.`;
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

      let editTools = parseResponse(content, agentMsgId, false).toolCalls.filter(t => t.name === 'edit_file');
      if (editTools.length) {
        if (autoApplyWritesRef.current) {
          editTools = await autoApplyWritableTools(editTools, toolDeps);
          updateProgress(log => noteSavedFiles(log, editTools));
        }
        for (const tool of editTools) {
          if (tool.args?.path) touchedPaths.push(tool.args.path);
        }
      }
      const reviewTools = [...readTools, ...editTools];

      const parsedDecision = parseNextStep(content);
      const steered = parsedDecision
        ? avoidRepeat(progressRef.current, parsedDecision.decision, parsedDecision.task, parsedDecision.options)
        : null;
      const decision = parsedDecision
        ? { ...parsedDecision, decision: steered!.decision, task: steered!.task, options: steered!.options }
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
      const loopTask = (repeatTask || similarTask).trim();
      if (loopTask) {
        handledLoop = true;
        const key = stuckKey(loopTask);
        const stage: StuckStage = stuckRef.current.stage;
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
            display = `Stuck repeating. Retrying on ${big.node.name} · ${big.model} (${big.node.hardware?.vramGB || 0} GB).`;
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
          handoff = false;
          runTask = '';
          nextTask = '';
          pinStuck = undefined;
          pinFix = false;
          if (paid) {
            display = `Still stuck after the largest local model and the free tier. Confirm before a paid call to ${paid.node.name} · ${paid.model}.`;
            options = [{ id: 'use-paid-api', title: `Use paid API · ${paid.model}`, description: loopTask, action: 'paid' }];
          } else {
            display = 'Still stuck. No paid API node is available. Leave Free tier unchecked on a frontier key to use it as the paid step.';
            options = [];
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
      fullPrompt: pinFix || stuckTarget
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

  /** After the user picks a plan option — lock plan, switch to Coder, execute. */
  const executeChosenPlan = async (
    option: PlanOption,
    planMsg: ChatMessage,
    confirmationText: string,
    attachedImages: string[] = []
  ) => {
    const original = findPlanOriginalRequest(messagesRef.current, planMsg);
    const approved = buildApprovedPlan(planMsg, option, original);
    approvedPlanRef.current = approved;

    onSelectAgent(coderAgent.id);
    onConversationPatch?.({ approvedPlan: approved, agentId: coderAgent.id });
    if (coderAgent.autoApproveWrites !== undefined) {
      autoApplyWritesRef.current = coderAgent.autoApproveWrites;
      setAutoApplyWrites(coderAgent.autoApproveWrites);
    }

    const notice = `Executing plan as Coder — Option ${option.id}: ${option.title}`;
    setExecutingPlanNotice(notice);

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
      personaHandle: 'coder',
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

    const execPrompt = `${formatApprovedPlanForSwarm(approved)}\n\nImplement the chosen option now.`;
    let fullPrompt = execPrompt;
    if (includeActiveFile && activeTab) {
      fullPrompt = `[Active File: ${activeTab.name}]\n\`\`\`${activeTab.language}\n${activeTab.content}\n\`\`\`\n\n${execPrompt}`;
    }

    resetAgentLoopBudget();
    stopRequestedRef.current = false;

    // Swarm path: Pass 1 Lead Architect gets the approved plan text
    if (isPipelineMode && attachedImages.length === 0) {
      await handleSendPipelineMessage(confirmDisplay, fullPrompt, {
        approvedPlan: approved,
        skipUserAppend: true
      });
    } else {
      await runSingleNodeTurn({
        userText: confirmDisplay,
        fullPrompt,
        attachedImages,
        agent: coderAgent,
        planMode: false,
        approvedPlan: approved,
        skipUserAppend: true,
        notice
      });
    }
    if (!stopRequestedRef.current) await reviewAndAdvance(0);
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
    if (option.action === 'stop') {
      setMessages(prev =>
        prev.map(m => (m.id === planMsg.id ? { ...m, selectedPlanOptionId: option.id } : m))
      );
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

    // New request clears a prior locked plan unless we're mid-option-match
    if (approvedPlanRef.current && isPlannerSelected) {
      approvedPlanRef.current = null;
      onConversationPatch?.({ approvedPlan: null });
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

  return (
    <div
      style={{ width }}
      className="h-full bg-[#161619] border-l border-[#27272a] flex flex-col select-none shrink-0"
    >
      {/* Conductor & Mode Selector Header */}
      <div className="p-3 border-b border-[#27272a] bg-[#121215] flex flex-col space-y-2.5">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center space-x-1.5 text-xs font-bold text-zinc-200 min-w-0">
            <Sparkles className="w-3.5 h-3.5 text-indigo-400 shrink-0" />
            <span className="truncate" title={conversation?.title || 'Agent Conductor'}>
              {conversation?.title || 'Agent Conductor'}
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

        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center space-x-1 min-w-0">
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
          <HelpTip title="Agent personas" align="right">
            <p>Each handle is a different system prompt and default routing preference:</p>
            <ul className="list-disc pl-3.5 space-y-1">
              <li><b className="text-zinc-300">coder</b> — build & edit files; auto-applies writes</li>
              <li><b className="text-zinc-300">planner</b> — proposes a plan with 2–4 options; picking one auto-runs as Coder</li>
              <li><b className="text-zinc-300">reviewer</b> — bugs/security review; prefers the laptop node</li>
              <li><b className="text-zinc-300">docs</b> — explanations, tests, docs; prefers the server</li>
            </ul>
            <p>On Planner, click an option button or type <span className="font-mono text-zinc-300">option 1</span>. The next turn executes as Coder. After each coding step the largest enabled local model checks the work, may patch a bug in those files, and keeps going or stops with the next choices.</p>
            <p>Compact folds older messages when the chat gets large. Finished steps and the next step stay in the project work log and are sent with every turn, so the Conductor does not ask the same question again.</p>
          </HelpTip>
        </div>

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

        {/* Dynamic Hardware Dispatcher */}
        <div className="grid grid-cols-2 gap-2 text-[10px]">
          <div className="flex flex-col space-y-1">
            <span className="text-zinc-500 font-medium flex items-center justify-between gap-1">
              <span className="flex items-center space-x-1 min-w-0">
                {isFrontier ? <Cloud className="w-3 h-3 text-sky-400 shrink-0" /> : <Cpu className="w-3 h-3 text-emerald-400 shrink-0" />}
                <span className="truncate">Hardware Target</span>
                <HelpTip title="Hardware Target">
                  <p>Which PC / API endpoint runs this chat turn.</p>
                  <p><b className="text-zinc-300">Local nodes</b> (Main Rig, Linux Server, Laptop) use your Ollama GPUs for free.</p>
                  <p><b className="text-zinc-300">Frontier</b> (e.g. Grok) uses a cloud API key when you need stronger reasoning.</p>
                  <p>Picking a target manually turns off Auto-Node for this session.</p>
                </HelpTip>
              </span>
            </span>
            <select
              value={nodes.some(n => n.id === targetNodeId) ? targetNodeId : ''}
              onChange={(e) => {
                const newNodeId = e.target.value;
                setTargetNodeId(newNodeId);
                setAutoSelectEndpoint(false);
                const nextNode = nodes.find(n => n.id === newNodeId);
                if (nextNode) {
                  setTargetModel(getPreferredModelForNode(nextNode));
                }
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
            <span className="text-zinc-500 font-medium flex items-center justify-between gap-1">
              <span className="flex items-center space-x-1 min-w-0">
                <span className="truncate">Node Model</span>
                <HelpTip title="Node Model" align="right">
                  <p>Which Ollama (or frontier) model runs on the selected hardware.</p>
                  <p>Only models toggled <b className="text-zinc-300">ON</b> in Hardware Settings appear here. Embedding models are filtered out.</p>
                  <p>Setting a model here becomes that node’s default for Conductor jobs too.</p>
                </HelpTip>
              </span>
              {benchmarkStat && (
                <span className="text-amber-400 font-mono text-[9px] flex items-center space-x-0.5 shrink-0">
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
                if (selectedNode) {
                  onSelectNodeModel?.(selectedNode.id, newModel);
                }
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
                className={`mt-1 w-full flex items-center justify-center space-x-1.5 px-2 py-1 rounded border text-[10px] font-medium transition ${
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

        {/* Conductor Swarm & Routing Controls */}
        <div className="flex items-center justify-between pt-1 border-t border-[#22222a] text-[10px] gap-2">
          <div className="flex items-center space-x-1 min-w-0">
            <button
              onClick={() => setIsPipelineMode(!isPipelineMode)}
              className={`flex items-center space-x-1.5 px-2 py-1 rounded border transition ${
                isPipelineMode
                  ? 'bg-amber-500/20 border-amber-500/40 text-amber-300 font-semibold'
                  : 'bg-[#18181d] border-[#2a2a34] text-zinc-400 hover:text-zinc-200'
              }`}
              title={isPipelineMode ? 'Conductor Swarm is ON — click to use single-node chat' : 'Click to enable multi-GPU file distribution'}
            >
              <Share2 className="w-3 h-3 text-amber-400 shrink-0" />
              <span className="truncate">
                Conductor Swarm ({onlineLocalNodes.length} local
                {nodes.filter(n => n.online && isFrontierNode(n) && getEnabledModelsForNode(n).length > 0).length
                  ? ` + frontier`
                  : ''}
                )
              </span>
            </button>
            <HelpTip title="Conductor Swarm mode">
              <p><b className="text-zinc-300">Off (default):</b> one message → one node/model. Best for questions, edits, and single-file work.</p>
              <p><b className="text-zinc-300">On (contract-first):</b> Pass 1 locks a shared TypeScript contract on the Lead Architect GPU, verifies it with <code className="text-indigo-300">tsc</code>, then Pass 2 fans file workers across online GPUs with that contract injected read-only.</p>
              <p><b className="text-zinc-300">Local-first:</b> uses enabled models on online Ollama GPUs (high-VRAM @coder preferred for Pass 1). Frontier APIs only when no local workers are available.</p>
              <p>Each GPU runs one file at a time on one model, so a 16GB card is not asked to hold two models. Different PCs still run together. After workers finish, workspace <code className="text-indigo-300">tsc</code> routes errors back to the GPU that owns the broken file.</p>
            </HelpTip>
          </div>

          <div className="flex items-center space-x-2.5 shrink-0">
            <label className="flex items-center space-x-1 text-zinc-400 cursor-pointer hover:text-zinc-200">
              <input
                type="checkbox"
                checked={autoSelectEndpoint}
                onChange={(e) => setAutoSelectEndpoint(e.target.checked)}
                className="rounded border-[#31313e] bg-[#1e1e24] text-indigo-500"
              />
              <span>Auto-Node</span>
              <HelpTip title="Auto-Node" align="right">
                <p>When on, each send picks a hardware node from the task (e.g. review → laptop, docs → server, coding → main rig).</p>
                <p><b className="text-zinc-300">Local-first:</b> prefers online Ollama nodes; frontier APIs only if no local workers are up.</p>
                <p>Ignored while Conductor Swarm is on (Swarm assigns files + models itself).</p>
              </HelpTip>
            </label>

            <label className="flex items-center space-x-1 text-zinc-400 cursor-pointer hover:text-zinc-200">
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
              <HelpTip title="Auto-apply" align="right">
                <p>When on, file writes/edits apply immediately, PowerShell <code className="text-indigo-300">run_command</code> tools execute, and failed commands feed back so the agent can self-correct from terminal output.</p>
                <p>When off, you review each card and click Apply / Run yourself.</p>
              </HelpTip>
            </label>
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

                {/* Planner option buttons */}
                {msg.planOptions && msg.planOptions.length > 0 && (
                  <PlanOptionsCard
                    options={msg.planOptions}
                    selectedId={msg.selectedPlanOptionId}
                    disabled={isStreaming}
                    onSelect={opt => handleSelectPlanOption(opt, msg)}
                  />
                )}

                {/* Tool Invocations */}
                {msg.toolCalls && msg.toolCalls.length > 0 && (
                  <div className="mt-3 space-y-2 pt-2 border-t border-[#31313e]">
                    <div className="flex items-center justify-between">
                      <div className="text-[10px] uppercase font-bold text-indigo-300 tracking-wider">
                        Workspace Actions ({msg.toolCalls.length}):
                      </div>
                      {msg.toolCalls.some(t => t.status !== 'done') && (
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
                    {msg.toolCalls.map(tool => (
                      <ToolActionCard
                        key={tool.id}
                        tool={tool}
                        workspacePath={workspacePath}
                        onApplyFileWrite={onApplyFileWrite}
                        onExecuteToolCommand={onExecuteToolCommand}
                        onOpenFileInEditor={onOpenFileInEditor}
                        onRunSingleTool={runSingleTool}
                      />
                    ))}
                  </div>
                )}
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
  );
};
