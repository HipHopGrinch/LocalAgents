import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { Header } from './components/Header';
import { FileTree } from './components/FileTree';
import { EditorView } from './components/EditorView';
import { TerminalPanel } from './components/TerminalPanel';
import { AgentChat } from './components/AgentChat';
import { HardwareSettingsModal } from './components/HardwareSettingsModal';

import {
  EndpointNode,
  NodeConfig,
  WorkspaceFile,
  OpenTab,
  AppSettings,
  ChatConversation,
  ChatMessage
} from './types';
import { DEFAULT_SETTINGS, mergeSettings } from './config/defaults';
import { getLanguageFromPath } from './utils/language';
import {
  conversationsForWorkspace,
  createConversation,
  titleFromMessages,
  upsertConversation
} from './lib/conversations';

export const App: React.FC = () => {
  const [workspacePath, setWorkspacePath] = useState<string>('');
  const [files, setFiles] = useState<WorkspaceFile[]>([]);
  const [openTabs, setOpenTabs] = useState<OpenTab[]>([]);
  const [activeTabPath, setActiveTabPath] = useState<string | undefined>(undefined);

  // Settings & Cluster
  const [settings, setSettings] = useState<AppSettings>(DEFAULT_SETTINGS);
  const [nodes, setNodes] = useState<EndpointNode[]>(() =>
    DEFAULT_SETTINGS.nodes.map(n => ({
      ...n,
      online: false,
      latency: null,
      models: [],
      loaded: []
    }))
  );
  const [selectedAgentId, setSelectedAgentId] = useState<string>(DEFAULT_SETTINGS.agents[0].id);
  const [activeConversationId, setActiveConversationId] = useState<string | undefined>(undefined);

  // Modals & Drawers
  const [isTerminalOpen, setIsTerminalOpen] = useState(false);
  const [isHardwareModalOpen, setIsHardwareModalOpen] = useState(false);

  // Resizable Sidebar Widths
  const [explorerWidth, setExplorerWidth] = useState<number>(DEFAULT_SETTINGS.explorerWidth || 240);
  const [chatWidth, setChatWidth] = useState<number>(DEFAULT_SETTINGS.chatWidth || 420);
  const [resizingSide, setResizingSide] = useState<'explorer' | 'chat' | null>(null);

  // UI & Text Scaling (Discord-style zoom factor: 0.75 to 2.0)
  const [uiScale, setUiScale] = useState<number>(DEFAULT_SETTINGS.uiScale || 1.0);

  // 1. Initial Load: Settings & Workspace
  useEffect(() => {
    async function init() {
      if (!window.electronAPI) return;

      const saved = await window.electronAPI.loadSettings();
      const merged = mergeSettings(saved);
      setSettings(merged);
      if (merged.explorerWidth) setExplorerWidth(merged.explorerWidth);
      if (merged.chatWidth) setChatWidth(merged.chatWidth);
      if (merged.activeConversationId) setActiveConversationId(merged.activeConversationId);
      
      const initialScale = merged.uiScale || 1.0;
      setUiScale(initialScale);
      if (window.electronAPI.setZoomFactor) {
        window.electronAPI.setZoomFactor(initialScale);
      }
      document.documentElement.style.setProperty('--app-scale', String(initialScale));

      // Initialize live nodes
      setNodes(
        merged.nodes.map(n => ({
          ...n,
          online: false,
          latency: null,
          models: [],
          loaded: []
        }))
      );

      const defaultPath = merged.lastWorkspace || (await window.electronAPI.getDefaultWorkspace());
      setWorkspacePath(defaultPath);
      loadDirectory(defaultPath);
    }
    init();
  }, []);

  // Persist Settings whenever modified
  const updateSettings = useCallback((partial: Partial<AppSettings>) => {
    setSettings(prev => {
      const next = { ...prev, ...partial };
      if (window.electronAPI) {
        window.electronAPI.saveSettings(next);
      }
      return next;
    });
  }, []);

  const handleUpdateUiScale = useCallback((scale: number) => {
    const clamped = Math.max(0.75, Math.min(2.0, Math.round(scale * 100) / 100));
    setUiScale(clamped);
    if (window.electronAPI?.setZoomFactor) {
      window.electronAPI.setZoomFactor(clamped);
    }
    document.documentElement.style.setProperty('--app-scale', String(clamped));
    updateSettings({ uiScale: clamped });
  }, [updateSettings]);

  // Global Keyboard Zoom Shortcuts: Ctrl + / Ctrl - / Ctrl 0
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey) {
        if (e.key === '=' || e.key === '+') {
          e.preventDefault();
          handleUpdateUiScale(uiScale + 0.05);
        } else if (e.key === '-' || e.key === '_') {
          e.preventDefault();
          handleUpdateUiScale(uiScale - 0.05);
        } else if (e.key === '0') {
          e.preventDefault();
          handleUpdateUiScale(1.0);
        }
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [uiScale, handleUpdateUiScale]);

  const workspaceConversations = useMemo(
    () => conversationsForWorkspace(settings.conversations, workspacePath),
    [settings.conversations, workspacePath]
  );

  const activeConversation: ChatConversation | null = useMemo(() => {
    if (!activeConversationId) return null;
    return (settings.conversations || []).find(c => c.id === activeConversationId) || null;
  }, [settings.conversations, activeConversationId]);

  // Ensure an active chat exists for the current workspace
  useEffect(() => {
    if (!workspacePath) return;
    setSettings(prev => {
      const forWs = conversationsForWorkspace(prev.conversations, workspacePath);
      const activeStillValid =
        activeConversationId && forWs.some(c => c.id === activeConversationId);
      if (activeStillValid) return prev;

      if (forWs[0]) {
        setActiveConversationId(forWs[0].id);
        const next = { ...prev, activeConversationId: forWs[0].id };
        if (window.electronAPI) window.electronAPI.saveSettings(next);
        return next;
      }

      const fresh = createConversation(workspacePath, selectedAgentId);
      setActiveConversationId(fresh.id);
      const next = {
        ...prev,
        conversations: upsertConversation(prev.conversations, fresh),
        activeConversationId: fresh.id
      };
      if (window.electronAPI) window.electronAPI.saveSettings(next);
      return next;
    });
  }, [workspacePath]);

  // Sidebar Drag-Resize Listeners
  useEffect(() => {
    if (!resizingSide) return;

    const handleMouseMove = (e: MouseEvent) => {
      if (resizingSide === 'explorer') {
        const nextWidth = Math.max(160, Math.min(540, e.clientX));
        setExplorerWidth(nextWidth);
      } else if (resizingSide === 'chat') {
        const nextWidth = Math.max(300, Math.min(820, window.innerWidth - e.clientX));
        setChatWidth(nextWidth);
      }
    };

    const handleMouseUp = () => {
      setResizingSide(null);
      updateSettings({ explorerWidth, chatWidth });
    };

    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', handleMouseUp);
    return () => {
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
    };
  }, [resizingSide, explorerWidth, chatWidth, updateSettings]);

  // 3. Cluster Polling — preserve user toggles/benchmarks; only merge live status fields
  const nodesRef = React.useRef(nodes);
  nodesRef.current = nodes;

  const refreshNodes = useCallback(async () => {
    if (!window.electronAPI) return;
    const endpointsToPing = nodesRef.current.map(n => ({
      id: n.id,
      url: n.url,
      type: n.type,
      apiKey: n.apiKey
    }));

    try {
      const results = await window.electronAPI.clusterStatus(endpointsToPing);
      setNodes(prev =>
        prev.map(n => {
          const res = results[n.id];
          if (res) {
            const meta = n.modelMeta || {};
            const models = (res.models || []).map(m => {
              const cached = meta[m.name];
              return {
                ...m,
                capabilities: m.capabilities || cached?.capabilities,
                description: cached?.description,
                thinking: cached?.thinking
              };
            });
            return {
              ...n,
              online: res.online,
              latency: res.latency,
              models,
              loaded: res.loaded || [],
              error: res.error
              // disabledModels / activeModel / benchmarks / modelMeta / modelPrefs retained via ...n
            };
          }
          return n;
        })
      );
    } catch (err) {
      console.error('Error pinging cluster nodes:', err);
    }
  }, []);

  useEffect(() => {
    refreshNodes();
    const interval = setInterval(refreshNodes, (settings.pollIntervalSec || 15) * 1000);
    return () => clearInterval(interval);
  }, [settings.pollIntervalSec, refreshNodes]);

  // 4. File Tree
  const loadDirectory = async (dirPath: string) => {
    if (!window.electronAPI) return;
    const result = await window.electronAPI.readDir(dirPath);
    if (Array.isArray(result)) {
      setFiles(result);
    }
  };

  const handleSelectFolder = async () => {
    if (!window.electronAPI) return;
    const chosen = await window.electronAPI.selectFolder();
    if (chosen) {
      setWorkspacePath(chosen);
      setOpenTabs([]);
      setActiveTabPath(undefined);
      setActiveConversationId(undefined); // workspace effect will attach/create chat
      updateSettings({ lastWorkspace: chosen, activeConversationId: undefined });
      loadDirectory(chosen);
    }
  };

  /** New project: pick folder, clear tabs, start a brand-new chat for that workspace. */
  const handleNewProject = async () => {
    if (!window.electronAPI) return;
    const chosen = await window.electronAPI.selectFolder();
    if (!chosen) return;

    const fresh = createConversation(chosen, selectedAgentId);
    setWorkspacePath(chosen);
    setOpenTabs([]);
    setActiveTabPath(undefined);
    setActiveConversationId(fresh.id);
    setSettings(prev => {
      const next = {
        ...prev,
        lastWorkspace: chosen,
        conversations: upsertConversation(prev.conversations, fresh),
        activeConversationId: fresh.id
      };
      window.electronAPI.saveSettings(next);
      return next;
    });
    loadDirectory(chosen);
  };

  const handleNewChat = () => {
    const fresh = createConversation(workspacePath, selectedAgentId);
    setActiveConversationId(fresh.id);
    setSettings(prev => {
      const next = {
        ...prev,
        conversations: upsertConversation(prev.conversations, fresh),
        activeConversationId: fresh.id
      };
      if (window.electronAPI) window.electronAPI.saveSettings(next);
      return next;
    });
  };

  const handleSelectConversation = (id: string) => {
    setActiveConversationId(id);
    updateSettings({ activeConversationId: id });
    const conv = (settings.conversations || []).find(c => c.id === id);
    if (conv?.agentId) setSelectedAgentId(conv.agentId);
  };

  const handleDeleteConversation = (id: string) => {
    setSettings(prev => {
      const remaining = (prev.conversations || []).filter(c => c.id !== id);
      let nextActive = prev.activeConversationId;
      if (id === activeConversationId) {
        const forWs = conversationsForWorkspace(remaining, workspacePath);
        if (forWs[0]) {
          nextActive = forWs[0].id;
        } else {
          const fresh = createConversation(workspacePath, selectedAgentId);
          remaining.unshift(fresh);
          nextActive = fresh.id;
        }
        setActiveConversationId(nextActive);
      }
      const next = {
        ...prev,
        conversations: remaining.slice(0, 40),
        activeConversationId: nextActive
      };
      if (window.electronAPI) window.electronAPI.saveSettings(next);
      return next;
    });
  };

  const handleMessagesChange = (messages: ChatMessage[]) => {
    if (!activeConversationId) return;
    setSettings(prev => {
      const existing = (prev.conversations || []).find(c => c.id === activeConversationId);
      if (!existing) return prev;
      // Avoid noop writes when switching threads loads the same snapshot
      if (
        existing.messages.length === messages.length &&
        existing.messages[existing.messages.length - 1]?.id === messages[messages.length - 1]?.id &&
        existing.messages[existing.messages.length - 1]?.raw === messages[messages.length - 1]?.raw &&
        existing.messages.every((m, i) => m.id === messages[i]?.id && m.display === messages[i]?.display)
      ) {
        return prev;
      }
      const updated: ChatConversation = {
        ...existing,
        messages,
        title: titleFromMessages(messages),
        agentId: selectedAgentId,
        workspacePath,
        updatedAt: Date.now()
      };
      const next = {
        ...prev,
        conversations: upsertConversation(prev.conversations, updated)
      };
      if (window.electronAPI) window.electronAPI.saveSettings(next);
      return next;
    });
  };

  // 5. Editor Tabs
  const handleFileSelect = async (filePath: string) => {
    const existing = openTabs.find(t => t.path === filePath);
    if (existing) {
      setActiveTabPath(filePath);
      return;
    }

    if (!window.electronAPI) return;
    const res = await window.electronAPI.readFile(filePath);
    if (res.content !== undefined) {
      const fileName = filePath.split(/[\\/]/).pop() || 'Untitled';
      const newTab: OpenTab = {
        path: filePath,
        name: fileName,
        content: res.content,
        originalContent: res.content,
        isDirty: false,
        language: getLanguageFromPath(filePath)
      };
      setOpenTabs(prev => [...prev, newTab]);
      setActiveTabPath(filePath);
    }
  };

  const handleCloseTab = (path: string) => {
    setOpenTabs(prev => {
      const filtered = prev.filter(t => t.path !== path);
      if (activeTabPath === path) {
        const nextActive = filtered.length > 0 ? filtered[filtered.length - 1].path : undefined;
        setActiveTabPath(nextActive);
      }
      return filtered;
    });
  };

  const handleContentChange = (path: string, newContent: string) => {
    setOpenTabs(prev =>
      prev.map(tab => {
        if (tab.path === path) {
          return {
            ...tab,
            content: newContent,
            isDirty: newContent !== tab.originalContent
          };
        }
        return tab;
      })
    );
  };

  const handleSaveTab = async (path: string) => {
    const tab = openTabs.find(t => t.path === path);
    if (!tab || !window.electronAPI) return;

    const res = await window.electronAPI.writeFile(path, tab.content);
    if (res.success) {
      setOpenTabs(prev =>
        prev.map(t => (t.path === path ? { ...t, originalContent: tab.content, isDirty: false } : t))
      );
      loadDirectory(workspacePath);
    }
  };

  const handleCreateFile = async (dirPath: string) => {
    const name = prompt('Enter new file name:');
    if (!name || !window.electronAPI) return;
    const fullPath = `${dirPath}\\${name}`;
    await window.electronAPI.createFile(fullPath);
    await loadDirectory(workspacePath);
    handleFileSelect(fullPath);
  };

  const handleCreateFolder = async (dirPath: string) => {
    const name = prompt('Enter new folder name:');
    if (!name || !window.electronAPI) return;
    const fullPath = `${dirPath}\\${name}`;
    await window.electronAPI.createFolder(fullPath);
    loadDirectory(workspacePath);
  };

  const handleDeleteTarget = async (targetPath: string) => {
    if (!window.electronAPI) return;
    await window.electronAPI.deleteTarget(targetPath);
    handleCloseTab(targetPath);
    loadDirectory(workspacePath);
  };

  // 6. Agent Tool Execution Callbacks (workspace-scoped via tools:exec)
  const handleApplyFileWrite = async (filePath: string, content: string): Promise<boolean> => {
    if (!window.electronAPI || !workspacePath) return false;

    // Prefer scoped agent write so paths cannot escape the open workspace
    const scoped = await window.electronAPI.execTool(workspacePath, 'write_file', {
      path: filePath,
      content
    });
    if (scoped.error) {
      console.error('Scoped write failed:', scoped.error);
      return false;
    }

    const absolutePath = scoped.path || (filePath.includes(':') ? filePath : `${workspacePath}\\${filePath.replace(/^[\\/]+/, '')}`);
    await loadDirectory(workspacePath);
    setOpenTabs(prev => {
      const idx = prev.findIndex(t => t.path === absolutePath);
      if (idx >= 0) {
        const updated = [...prev];
        updated[idx] = { ...updated[idx], content, originalContent: content, isDirty: false };
        return updated;
      }
      const fileName = absolutePath.split(/[\\/]/).pop() || 'file';
      const newTab: OpenTab = {
        path: absolutePath,
        name: fileName,
        content,
        originalContent: content,
        isDirty: false,
        language: getLanguageFromPath(absolutePath)
      };
      return [...prev, newTab];
    });
    setActiveTabPath(absolutePath);
    return true;
  };

  const handleExecuteToolCommand = async (command: string): Promise<string> => {
    setIsTerminalOpen(true);
    if (!window.electronAPI || !workspacePath) return '';
    const res = await window.electronAPI.execTool(workspacePath, 'run_command', { command });
    return res.content || res.error || '';
  };

  const handleOpenFileInEditor = (filePath: string) => {
    const absolutePath = filePath.includes(':') ? filePath : `${workspacePath}\\${filePath.replace(/^\//, '')}`;
    handleFileSelect(absolutePath);
  };

  // 7. Node / Hardware Updates
  const handleUpdateNodes = (updatedNodes: NodeConfig[]) => {
    // Persist config fields only (strip live status if present)
    const configs: NodeConfig[] = updatedNodes.map(n => {
      const { online: _o, latency: _l, models: _m, loaded: _ld, error: _e, ...cfg } = n as EndpointNode;
      return cfg;
    });
    updateSettings({ nodes: configs });
    setNodes(prev =>
      updatedNodes.map(un => {
        const existing = prev.find(p => p.id === un.id);
        const meta = un.modelMeta || existing?.modelMeta || {};
        const incomingModels = (un as EndpointNode).models;
        const liveModels = Array.isArray(incomingModels) ? incomingModels : (existing?.models ?? []);
        return {
          ...un,
          online: existing?.online ?? false,
          latency: existing?.latency ?? null,
          loaded: existing?.loaded ?? [],
          error: existing?.error,
          models: liveModels.map(m => ({
            ...m,
            capabilities: m.capabilities || meta[m.name]?.capabilities,
            description: meta[m.name]?.description || m.description,
            thinking: meta[m.name]?.thinking || m.thinking
          }))
        };
      })
    );
  };

  const handleSelectNodeModel = (nodeId: string, model: string) => {
    const updatedConfigs: NodeConfig[] = nodes.map(n => {
      const { online, latency, models, loaded, error, ...cfg } = n;
      if (cfg.id === nodeId) {
        return { ...cfg, activeModel: model };
      }
      return cfg;
    });
    handleUpdateNodes(updatedConfigs);
  };

  const handleToggleModelThinking = (nodeId: string, modelName: string, enabled: boolean) => {
    const updatedConfigs: NodeConfig[] = nodes.map(n => {
      const { online, latency, models, loaded, error, ...cfg } = n;
      if (cfg.id !== nodeId) return cfg;
      return {
        ...cfg,
        modelPrefs: {
          ...(cfg.modelPrefs || {}),
          [modelName]: { ...(cfg.modelPrefs?.[modelName] || {}), think: enabled }
        }
      };
    });
    handleUpdateNodes(updatedConfigs);
  };

  const handleRecordTokens = (localCount: number, frontierCount: number) => {
    updateSettings({
      localTokensGenerated: (settings.localTokensGenerated || 0) + localCount,
      frontierTokensUsed: (settings.frontierTokensUsed || 0) + frontierCount
    });
  };

  return (
    <div className="flex flex-col h-screen w-screen bg-[#18181b] text-zinc-100 overflow-hidden font-sans select-none">
      {/* Top Header */}
      <Header
        workspacePath={workspacePath}
        onSelectFolder={handleSelectFolder}
        onNewProject={handleNewProject}
        nodes={nodes}
        onRefreshNodes={refreshNodes}
        isTerminalOpen={isTerminalOpen}
        onToggleTerminal={() => setIsTerminalOpen(!isTerminalOpen)}
        onOpenHardwareModal={() => setIsHardwareModalOpen(true)}
        localTokens={settings.localTokensGenerated || 0}
        frontierTokens={settings.frontierTokensUsed || 0}
        uiScale={uiScale}
        onUpdateUiScale={handleUpdateUiScale}
      />

      {/* Main Studio Body */}
      <div className="flex-1 flex overflow-hidden">
        {/* Explorer */}
        <FileTree
          files={files}
          activeFilePath={activeTabPath}
          onFileSelect={handleFileSelect}
          onRefresh={() => loadDirectory(workspacePath)}
          onCreateFile={handleCreateFile}
          onCreateFolder={handleCreateFolder}
          onDelete={handleDeleteTarget}
          rootPath={workspacePath}
          width={explorerWidth}
        />

        {/* Explorer Drag Resize Handle */}
        <div
          onMouseDown={() => setResizingSide('explorer')}
          title="Drag to resize Explorer sidebar"
          className={`w-1 cursor-col-resize transition-colors shrink-0 ${
            resizingSide === 'explorer' ? 'bg-indigo-500' : 'bg-transparent hover:bg-indigo-500/60'
          }`}
        />

        {/* Center Monaco Editor & Terminal */}
        <div className="flex-1 flex flex-col overflow-hidden min-w-[260px]">
          <EditorView
            tabs={openTabs}
            activeTabPath={activeTabPath}
            onSelectTab={setActiveTabPath}
            onCloseTab={handleCloseTab}
            onContentChange={handleContentChange}
            onSaveTab={handleSaveTab}
          />

          <TerminalPanel
            isOpen={isTerminalOpen}
            onClose={() => setIsTerminalOpen(false)}
            workspacePath={workspacePath}
          />
        </div>

        {/* Agent Conductor Drag Resize Handle */}
        <div
          onMouseDown={() => setResizingSide('chat')}
          title="Drag to resize Agent Conductor sidebar"
          className={`w-1 cursor-col-resize transition-colors shrink-0 ${
            resizingSide === 'chat' ? 'bg-indigo-500' : 'bg-transparent hover:bg-indigo-500/60'
          }`}
        />

        {/* Right AI Agent Pane */}
        <AgentChat
          agents={settings.agents}
          selectedAgentId={selectedAgentId}
          onSelectAgent={setSelectedAgentId}
          nodes={nodes}
          activeTab={openTabs.find(t => t.path === activeTabPath)}
          workspacePath={workspacePath}
          workspaceFiles={files}
          width={chatWidth}
          onSelectNodeModel={handleSelectNodeModel}
          onApplyFileWrite={handleApplyFileWrite}
          onExecuteToolCommand={handleExecuteToolCommand}
          onOpenFileInEditor={handleOpenFileInEditor}
          onRecordTokens={handleRecordTokens}
          conversation={activeConversation}
          workspaceConversations={workspaceConversations}
          onMessagesChange={handleMessagesChange}
          onNewChat={handleNewChat}
          onSelectConversation={handleSelectConversation}
          onDeleteConversation={handleDeleteConversation}
          onToggleModelThinking={handleToggleModelThinking}
        />
      </div>

      {/* Hardware Settings, Benchmarks & Frontier Config Modal */}
      <HardwareSettingsModal
        isOpen={isHardwareModalOpen}
        onClose={() => setIsHardwareModalOpen(false)}
        nodes={nodes}
        onUpdateNodes={handleUpdateNodes}
        onRefreshNodes={refreshNodes}
        estimateContext={settings.estimateContext || 16384}
        onUpdateEstimateContext={(ctx) => updateSettings({ estimateContext: ctx })}
        localTokens={settings.localTokensGenerated || 0}
        frontierTokens={settings.frontierTokensUsed || 0}
        uiScale={uiScale}
        onUpdateUiScale={handleUpdateUiScale}
      />
    </div>
  );
};
