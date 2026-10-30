import React, { useState, useRef, useEffect } from 'react';
import {
  AgentPersona,
  EndpointNode,
  ChatMessage,
  ToolCall,
  OpenTab,
  PipelineStep,
  ChatConversation,
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
  X
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
  looksLikeCreateIntent
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
  runReadOnlyTools,
  shouldContinueFromTools
} from '../lib/agentLoop';
import { streamChat } from '../lib/ollamaClient';
import { ToolActionCard } from './agent/ToolActionCard';
import { HelpTip } from './agent/HelpTip';
import { ActivityIndicator, streamingActivityLabel } from './agent/ActivityIndicator';
import { modelSupportsThinking, resolveThinkOption, thinkingToggleLabel } from '../lib/thinking';
import { fileToChatImage, modelSupportsVision, toOllamaBase64 } from '../lib/images';

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
  /** Active chat thread (controlled by App) */
  conversation: ChatConversation | null;
  workspaceConversations: ChatConversation[];
  onMessagesChange: (messages: ChatMessage[]) => void;
  onNewChat: () => void;
  onSelectConversation: (id: string) => void;
  onDeleteConversation: (id: string) => void;
  /** Persist think on/off for a model on a node */
  onToggleModelThinking?: (nodeId: string, modelName: string, enabled: boolean) => void;
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
  conversation,
  workspaceConversations,
  onMessagesChange,
  onNewChat,
  onSelectConversation,
  onDeleteConversation,
  onToggleModelThinking
}) => {
  const currentAgent = agents.find(a => a.id === selectedAgentId) || agents[0];

  // Routing states
  const [targetNodeId, setTargetNodeId] = useState<string>(currentAgent.endpointId);
  const [targetModel, setTargetModel] = useState<string>(currentAgent.model);
  const [autoSelectEndpoint, setAutoSelectEndpoint] = useState<boolean>(true);
  const [includeActiveFile, setIncludeActiveFile] = useState(true);
  const [isPipelineMode, setIsPipelineMode] = useState(false);
  const [autoApplyWrites, setAutoApplyWrites] = useState<boolean>(currentAgent.autoApproveWrites ?? true);

  const [input, setInput] = useState('');
  const [pendingImages, setPendingImages] = useState<string[]>([]);
  const [messages, setMessages] = useState<ChatMessage[]>(conversation?.messages || []);
  const [isStreaming, setIsStreaming] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const chatBottomRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const activeAbortsRef = useRef<(() => void)[]>([]);
  const messagesRef = useRef<ChatMessage[]>([]);
  const continuationDepthRef = useRef(0);
  const commandFixAttemptsRef = useRef(0);
  const prevFailedCmdSigsRef = useRef<string[]>([]);
  const conversationIdRef = useRef<string | null>(conversation?.id ?? null);

  const resetAgentLoopBudget = () => {
    continuationDepthRef.current = 0;
    commandFixAttemptsRef.current = 0;
    prevFailedCmdSigsRef.current = [];
  };

  const continueDecisionOpts = () => ({
    commandFixAttempts: commandFixAttemptsRef.current,
    prevFailedCmdSigs: prevFailedCmdSigsRef.current
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
      setInput('');
      setPendingImages([]);
      setHistoryOpen(false);
    }
  }, [conversation?.id]);

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
    onExecuteToolCommand
  };

  // Sync node, model & permissions when agent changes
  useEffect(() => {
    setTargetNodeId(currentAgent.endpointId);
    const agentNode = nodes.find(n => n.id === currentAgent.endpointId);
    setTargetModel(getPreferredModelForNode(agentNode, currentAgent.model));
    if (currentAgent.autoApproveWrites !== undefined) {
      setAutoApplyWrites(currentAgent.autoApproveWrites);
    }
  }, [currentAgent]);

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

  const benchmarkStat = selectedNode?.benchmarks?.[targetModel];
  const selectedModelInfo =
    selectedNode?.models?.find(m => m.name === targetModel) ||
    (selectedNode?.modelMeta?.[targetModel]
      ? {
          name: targetModel,
          capabilities: selectedNode.modelMeta[targetModel].capabilities,
          thinking: selectedNode.modelMeta[targetModel].thinking
        }
      : undefined);
  const selectedSupportsThink = modelSupportsThinking(selectedModelInfo);
  const selectedThinkPref = selectedNode?.modelPrefs?.[targetModel]?.think;
  const selectedThinkOn =
    selectedThinkPref === true ||
    selectedThinkPref === 'true' ||
    (typeof selectedThinkPref === 'string' && selectedThinkPref !== 'false');
  const selectedSupportsVision = modelSupportsVision(
    targetModel,
    selectedNode,
    selectedNode?.models?.find(m => m.name === targetModel)
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

  // ==========================================
  // UNIFIED TOOL EXECUTION & AGENTIC LOOP
  // ==========================================
  const runSingleTool = async (tool: ToolCall): Promise<ToolCall> => {
    const updated = await executeTool(tool, toolDeps);
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
    opts?: { expectedFilePath?: string; createIntent?: boolean; node?: EndpointNode; model?: string }
  ) => {
    if (continuationDepthRef.current >= MAX_TOOL_CONTINUATIONS) return;

    const feedbackTools = collectFeedbackTools(originMsg.toolCalls || []);
    if (feedbackTools.length === 0) return;
    if (!shouldContinueFromTools(originMsg.toolCalls || [], continueDecisionOpts())) return;

    const cmdFailed = feedbackTools.some(t => t.name === 'run_command' && t.status === 'error');
    const priorFixAttempts = commandFixAttemptsRef.current;
    if (cmdFailed) {
      prevFailedCmdSigsRef.current = [
        ...new Set([...prevFailedCmdSigsRef.current, ...failedCommandSignatures(feedbackTools)])
      ];
      commandFixAttemptsRef.current += 1;
    }

    continuationDepthRef.current += 1;
    const routeNode = opts?.node || selectedNode;
    if (!routeNode) return;
    const routeModel = opts?.model || targetModel;
    const followUpId = `followup-${Date.now()}`;
    const followUpMsg: ChatMessage = {
      id: followUpId,
      role: 'assistant',
      raw: '',
      display: cmdFailed
        ? 'Command failed — one fix attempt from terminal output...'
        : 'Analyzed project files. Now generating implementation...',
      agentId: currentAgent.id,
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
      const systemPrompt = buildSystemPrompt(currentAgent, workspacePath, workspaceOverview);
      const snap = messagesRef.current;
      const conversationPayload = [
        { role: 'system', content: systemPrompt },
        ...historyForModel(snap.filter(m => m.id !== followUpId), stripThinking),
        {
          role: 'assistant',
          content: stripThinking(originMsg.raw || 'I inspected the project / terminal.')
        },
        { role: 'user', content: continuationPrompt }
      ];

      const body = withThink({
        model: routeModel,
        messages: conversationPayload,
        options: {
          temperature: currentAgent.temperature,
          num_ctx: currentAgent.numCtx
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
          setMessages(prev => prev.map(m => {
            if (m.id === followUpId) {
              return {
                ...m,
                raw: content,
                display: parsed.display || content,
                thinking: parsed.thinking || thinking,
                toolCalls: parsed.toolCalls
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
      let finalParsed = parseResponse(result.content, followUpId, false, {
        expectedFilePath: opts?.expectedFilePath,
        createIntent: opts?.createIntent ?? true
      });

      let tools = finalParsed.toolCalls;
      const readPass = await runReadOnlyTools(tools, toolDeps);
      tools = readPass.tools;

      if (autoApplyWrites) {
        tools = await autoApplyWritableTools(tools, toolDeps);
        const cmdPass = await runCommandTools(tools, toolDeps);
        tools = cmdPass.tools;
      }

      const stillFailing =
        failedCommandSignatures(tools).length > 0 &&
        !shouldContinueFromTools(tools, continueDecisionOpts());
      const displayBase = finalParsed.display || result.content;
      const followUpMsgFinal: ChatMessage = {
        ...followUpMsg,
        raw: result.content,
        display: stillFailing
          ? `${displayBase}\n\n⚠️ Still failing after one auto-fix attempt — check the terminal, or ask to try again.`
          : displayBase,
        thinking: finalParsed.thinking || result.thinking,
        toolCalls: tools
      };

      setMessages(prev => prev.map(m => (m.id === followUpId ? followUpMsgFinal : m)));

      if (shouldContinueFromTools(tools, continueDecisionOpts())) {
        await continueWithToolResults(followUpMsgFinal, opts);
      }
    } catch (err: any) {
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
  const handleSendPipelineMessage = async (userText: string, fullPrompt: string) => {
    resetAgentLoopBudget();
    const userMsg: ChatMessage = {
      id: `msg-${Date.now()}`,
      role: 'user',
      raw: userText,
      display: userText,
      timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
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

      const workerSystemPrompt = buildSystemPrompt(currentAgent, workspacePath, workspaceOverview);
      const body = withThink(
        {
          model,
          messages: [
            { role: 'system', content: workerSystemPrompt },
            { role: 'user', content: userPrompt }
          ],
          options: { temperature: currentAgent.temperature, num_ctx: currentAgent.numCtx }
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

        let tools = parseResponse(res.content, `${agentMsgId}-${idx}`, false, {
          expectedFilePath,
          createIntent: true
        }).toolCalls;

        const readPass = await runReadOnlyTools(tools, toolDeps);
        tools = readPass.tools;

        if (autoApplyWrites) {
          tools = await autoApplyWritableTools(tools, toolDeps);
          const cmdPass = await runCommandTools(tools, toolDeps);
          tools = cmdPass.tools;
        }

        if (shouldContinueFromTools(tools, continueDecisionOpts())) {
          const origin: ChatMessage = {
            id: `${agentMsgId}-worker-${idx}`,
            role: 'assistant',
            raw: res.content,
            display: '',
            toolCalls: tools,
            timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
          };
          await continueWithToolResults(origin, {
            expectedFilePath,
            createIntent: true,
            node,
            model
          });
        }

        const parsedDisplay = parseResponse(res.content, `${agentMsgId}-${idx}`, false, {
          expectedFilePath,
          createIntent: true
        }).display;

        patchPipelineMsg(m => {
          if (!m.pipelineSteps) return m;
          const updatedSteps = [...m.pipelineSteps];
          if (updatedSteps[idx]) {
            updatedSteps[idx] = {
              ...updatedSteps[idx],
              status: 'completed',
              content:
                opts.stepLabel ||
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

    setMessages(prev => [...prev, userMsg, initialAgentMsg]);
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
      let manifest: SwarmManifest = fallbackSwarmManifest(userText);
      try {
        const snippets = await loadExistingSnippets();
        const architectPrompt = buildLeadArchitectPrompt(userText, workspaceOverview, snippets);
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
        const parsed = parseSwarmManifest(decompRes.content, userText);
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
      if (!writeOk) {
        patchPipelineMsg({
          display: `⚠️ Failed to write contract file \`${manifest.contractFile}\`. Aborting swarm.`
        });
        return;
      }

      if (
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
              userText,
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
            const repaired = parseSwarmManifest(repairRes.content, userText);
            if (repaired) {
              manifest = repaired;
              await onApplyFileWrite(manifest.contractFile, manifest.contractCode);
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
            const workerPrompt = buildSwarmWorkerPrompt({
              task: assignment.task,
              contractFile: manifest.contractFile,
              contractCode: manifest.contractCode,
              siblingSummary,
              currentFileContent: current,
              userPrompt: fullPrompt
            });
            await runWorkerTurn({
              idx: stepIdx,
              assignment,
              userPrompt: workerPrompt,
              expectedFilePath: assignment.task.filePath
            });
          }
        })
      );

      // ── Stage 4: Workspace Typecheck & Targeted Repair ──
      if (window.electronAPI?.typecheckWorkspace && workspacePath) {
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
      patchPipelineMsg({
        display: `⚠️ Conductor Swarm error: ${err?.message || err}`
      });
    } finally {
      setIsStreaming(false);
      activeAbortsRef.current = [];
    }
  };

  // ==========================================
  // STANDARD SINGLE-TASK EXECUTION
  // ==========================================
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
    resetAgentLoopBudget();

    let fullPrompt = userText;
    if (includeActiveFile && activeTab) {
      fullPrompt = `[Active File: ${activeTab.name}]\n\`\`\`${activeTab.language}\n${activeTab.content}\n\`\`\`\n\nUser Task / Request:\n${userText}`;
    }

    // Image paste skips parallel pipeline — vision needs a single multimodal turn
    if (isPipelineMode && !hasImages) {
      return handleSendPipelineMessage(userText, fullPrompt);
    }

    const createIntent = looksLikeCreateIntent(userText);

    // If autoSelectEndpoint is enabled, pick the best hardware node for this task,
    // and strictly use the user's chosen activeModel on that endpoint!
    const routedNode = autoSelectEndpoint
      ? selectBestEndpointForTask(userText, currentAgent.handle, nodes)
      : selectedNode;
    if (!routedNode) {
      setMessages(prev => [
        ...prev,
        {
          id: `msg-${Date.now()}`,
          role: 'user',
          raw: userText,
          display: userText,
          timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
          ...(attachedImages.length ? { images: attachedImages } : {})
        },
        {
          id: `agent-${Date.now()}`,
          role: 'assistant',
          raw: '',
          display: '⚠️ No endpoints configured. Open Hardware Settings and add an Ollama node (e.g. http://127.0.0.1:11434).',
          timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
          toolCalls: []
        }
      ]);
      return;
    }
    const routedModel = autoSelectEndpoint
      ? getPreferredModelForNode(routedNode, targetModel)
      : targetModel;
    const routedIsFrontier = routedNode?.type === 'openai' || !!routedNode?.apiKey;

    if (routedNode.id !== targetNodeId) {
      setTargetNodeId(routedNode.id);
    }
    if (routedModel !== targetModel) {
      setTargetModel(routedModel);
    }

    const userMsg: ChatMessage = {
      id: `msg-${Date.now()}`,
      role: 'user',
      raw: userText,
      display: userText,
      timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
      ...(attachedImages.length ? { images: attachedImages } : {})
    };

    const agentMsgId = `agent-${Date.now()}`;
    const initialAgentMsg: ChatMessage = {
      id: agentMsgId,
      role: 'assistant',
      raw: '',
      display: '',
      agentId: currentAgent.id,
      endpointId: routedNode.id,
      endpointName: routedNode.name,
      model: routedModel,
      timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
      toolCalls: []
    };

    setMessages(prev => [...prev, userMsg, initialAgentMsg]);
    setIsStreaming(true);

    try {
      const systemPrompt = buildSystemPrompt(currentAgent, workspacePath, workspaceOverview);
      const actionableUserPrompt = `${fullPrompt}\n\n[EXECUTION DIRECTIVE: If this request asks to create, build, or modify an application, script, or file, you MUST emit <write_file path="filename.ext">...complete code...</write_file> tags so the files are written directly to the user's computer. Do NOT just reply with conversational instructions.]`;
      const ollamaImages = attachedImages.map(toOllamaBase64);

      const conversationPayload = [
        { role: 'system', content: systemPrompt },
        ...historyForModel(messagesRef.current, stripThinking),
        {
          role: 'user',
          content: actionableUserPrompt,
          ...(ollamaImages.length ? { images: ollamaImages } : {})
        }
      ];

      const body = withThink({
        model: routedModel,
        messages: conversationPayload,
        options: {
          temperature: currentAgent.temperature,
          num_ctx: currentAgent.numCtx
        }
      }, routedNode, routedModel);

      const handle = streamChat(
        routedNode.url,
        body,
        (content, thinking) => {
          const parsed = parseResponse(content, agentMsgId, true, { createIntent });
          setMessages(prev => prev.map(m => {
            if (m.id === agentMsgId) {
              return {
                ...m,
                raw: content,
                display: parsed.display || content,
                thinking: parsed.thinking || thinking,
                toolCalls: parsed.toolCalls
              };
            }
            return m;
          }));
        },
        routedNode.type,
        routedNode.apiKey
      );

      activeAbortsRef.current = [handle.abort];
      const result = await handle.done;
      let finalParsed = parseResponse(result.content, agentMsgId, false, { createIntent });

      let tools = finalParsed.toolCalls;
      const readPass = await runReadOnlyTools(tools, toolDeps);
      tools = readPass.tools;

      if (autoApplyWrites) {
        tools = await autoApplyWritableTools(tools, toolDeps);
        const cmdPass = await runCommandTools(tools, toolDeps);
        tools = cmdPass.tools;
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

      const origin: ChatMessage = {
        id: agentMsgId,
        role: 'assistant',
        raw: result.content,
        display: finalParsed.display || result.content,
        thinking: finalParsed.thinking || result.thinking,
        toolCalls: tools,
        stats,
        timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
        agentId: currentAgent.id,
        endpointId: routedNode.id,
        endpointName: routedNode.name,
        model: routedModel
      };

      setMessages(prev => prev.map(m => (m.id === agentMsgId ? origin : m)));

      if (shouldContinueFromTools(tools, continueDecisionOpts())) {
        await continueWithToolResults(origin, { createIntent, node: routedNode, model: routedModel });
      }

    } catch (err: any) {
      setMessages(prev => prev.map(m => {
        if (m.id === agentMsgId) {
          return {
            ...m,
            display: m.display + `\n\n⚠️ Error on ${routedNode.name}: ${err.message}`
          };
        }
        return m;
      }));
    } finally {
      setIsStreaming(false);
      activeAbortsRef.current = [];
    }
  };

  const handleStop = () => {
    activeAbortsRef.current.forEach(abort => abort());
    activeAbortsRef.current = [];
    setIsStreaming(false);
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
              <li><b className="text-zinc-300">planner</b> — architecture plan first; cautious on writes</li>
              <li><b className="text-zinc-300">reviewer</b> — bugs/security review; prefers the laptop node</li>
              <li><b className="text-zinc-300">docs</b> — explanations, tests, docs; prefers the server</li>
            </ul>
            <p>Hover a handle for its one-line role. Switching persona changes how the model behaves, not which chat you are in.</p>
          </HelpTip>
        </div>

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
              value={effectiveModels.includes(targetModel) ? targetModel : ''}
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
            {selectedSupportsThink && onToggleModelThinking && selectedNode && targetModel && (
              <button
                type="button"
                onClick={() => onToggleModelThinking(selectedNode.id, targetModel, !selectedThinkOn)}
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
                onChange={(e) => setAutoApplyWrites(e.target.checked)}
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
                  {selectedNode
                    ? <>{selectedNode.name} → <code className="text-indigo-300">{targetModel}</code> {benchmarkStat ? `(~${benchmarkStat.evalTokPerSec} tok/s)` : ''}</>
                    : <span className="text-amber-400">none — add a node in Hardware Settings</span>}
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
                <span>{msg.role === 'user' ? 'You' : (msg.endpointName ? `${currentAgent.name} (${msg.endpointName})` : currentAgent.name)}</span>
                <span>•</span>
                <span>{msg.timestamp}</span>
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
                {targetModel} may not read images — pick a vision model like gemma4.
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
                isPipelineMode
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
