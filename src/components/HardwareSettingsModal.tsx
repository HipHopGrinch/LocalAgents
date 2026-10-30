import React, { useEffect, useRef, useState } from 'react';
import {
  X,
  Cpu,
  Key,
  Plus,
  Trash2,
  RefreshCw,
  Sliders,
  FolderOpen,
  Download,
  Upload,
  Lock
} from 'lucide-react';
import { EndpointNode, NodeConfig, HardwareProfile, ModelMeta } from '../types';
import { GPU_PRESETS, RAM_PRESETS } from '../config/defaults';
import { TaskId } from '../config/modelCatalog';
import { pullModel } from '../lib/ollamaClient';
import { isEmbeddingModelName } from '../lib/tools';
import { modelSupportsThinking, normalizeThinkingInfo } from '../lib/thinking';
import { ModelHubPanel } from './hardware/ModelHubPanel';
import { InstalledModelsPanel } from './hardware/InstalledModelsPanel';

interface HardwareSettingsModalProps {
  isOpen: boolean;
  onClose: () => void;
  nodes: EndpointNode[];
  onUpdateNodes: (nodes: NodeConfig[]) => void;
  onRefreshNodes: () => void;
  estimateContext: number;
  onUpdateEstimateContext: (ctx: number) => void;
  localTokens: number;
  frontierTokens: number;
  uiScale: number;
  onUpdateUiScale: (scale: number) => void;
  searxngUrl: string;
  onUpdateSearxngUrl: (url: string) => void;
}

export const HardwareSettingsModal: React.FC<HardwareSettingsModalProps> = ({
  isOpen,
  onClose,
  nodes,
  onUpdateNodes,
  onRefreshNodes,
  estimateContext,
  onUpdateEstimateContext,
  localTokens,
  frontierTokens,
  uiScale,
  onUpdateUiScale,
  searxngUrl,
  onUpdateSearxngUrl
}) => {
  const [activeTab, setActiveTab] = useState<'nodes' | 'hub' | 'appearance' | 'stats'>('nodes');
  const [selectedNodeId, setSelectedNodeId] = useState<string>(nodes[0]?.id || '');
  const [selectedTask, setSelectedTask] = useState<TaskId>('agent');
  const [settingsFilePath, setSettingsFilePath] = useState('');
  
  // Benchmark state
  const [benchmarkingModel, setBenchmarkingModel] = useState<string | null>(null);
  const [benchmarkingNodeId, setBenchmarkingNodeId] = useState<string | null>(null);

  // Pulling state
  const [pullProgress, setPullProgress] = useState<Record<string, { status: string; completed?: number; total?: number }>>({});

  // Add node form state
  const [showAddNode, setShowAddNode] = useState(false);
  const [newNodeName, setNewNodeName] = useState('');
  const [newNodeUrl, setNewNodeUrl] = useState('http://');
  const [newNodeType, setNewNodeType] = useState<'ollama' | 'openai'>('ollama');
  const [newNodeApiKey, setNewNodeApiKey] = useState('');

  // Custom remote pull state
  const [customPullTag, setCustomPullTag] = useState('');
  const [isPullingCustom, setIsPullingCustom] = useState(false);
  const [customPullStatus, setCustomPullStatus] = useState<string | null>(null);
  const [customPullPercent, setCustomPullPercent] = useState<number | null>(null);
  const [inspectingModel, setInspectingModel] = useState<string | null>(null);

  // Encrypted node export / import
  const [nodesIOMode, setNodesIOMode] = useState<'export' | 'import' | null>(null);
  const [nodesIOPassphrase, setNodesIOPassphrase] = useState('');
  const [nodesIOConfirm, setNodesIOConfirm] = useState('');
  const [nodesIOMergeMode, setNodesIOMergeMode] = useState<'replace' | 'merge'>('replace');
  const [nodesIOBusy, setNodesIOBusy] = useState(false);
  const [nodesIOError, setNodesIOError] = useState<string | null>(null);

  const nodesRef = useRef(nodes);
  nodesRef.current = nodes;

  const currentNode = nodes.find(n => n.id === selectedNodeId) || nodes[0];

  /** Merge /api/show into node modelMeta + live models; default think OFF for new thinking models. */
  const applyShowMeta = (nodeId: string, modelName: string, show: {
    capabilities?: string[];
    description?: string;
    thinking?: ModelMeta['thinking'];
  }) => {
    const thinking = normalizeThinkingInfo(show.thinking, show.capabilities) || show.thinking;
    const meta: ModelMeta = {
      thinking,
      capabilities: show.capabilities,
      description: show.description,
      fetchedAt: Date.now()
    };
    const supports = modelSupportsThinking({ name: modelName, capabilities: show.capabilities, thinking });

    const updated = nodesRef.current.map(n => {
      if (n.id !== nodeId) return n;
      const modelMeta = { ...(n.modelMeta || {}), [modelName]: meta };
      const modelPrefs = { ...(n.modelPrefs || {}) };
      if (supports && modelPrefs[modelName]?.think === undefined) {
        // Faster coding default; user can turn thinking back on
        modelPrefs[modelName] = { ...modelPrefs[modelName], think: false };
      }
      const models = (n.models || []).map(m =>
        m.name === modelName
          ? {
              ...m,
              capabilities: show.capabilities || m.capabilities,
              description: show.description || m.description,
              thinking
            }
          : m
      );
      return { ...n, modelMeta, modelPrefs, models };
    });
    onUpdateNodes(updated);
  };

  const inspectModel = async (node: EndpointNode, modelName: string) => {
    if (!window.electronAPI || node.type === 'openai') return;
    setInspectingModel(modelName);
    try {
      const show = await window.electronAPI.showModel(node.url, modelName);
      if (show.error) {
        console.warn('showModel failed:', show.error);
        return;
      }
      applyShowMeta(node.id, modelName, show);
    } finally {
      setInspectingModel(null);
    }
  };

  useEffect(() => {
    if (!isOpen || !window.electronAPI) return;
    window.electronAPI.settingsPath().then(setSettingsFilePath).catch(() => setSettingsFilePath(''));
  }, [isOpen]);

  // After opening Hardware Settings, inspect installed models missing Ollama metadata
  useEffect(() => {
    if (!isOpen || !currentNode || currentNode.type === 'openai' || !currentNode.online) return;
    const missing = (currentNode.models || []).filter(m => {
      if (isEmbeddingModelName(m.name, m.capabilities)) return false;
      return !currentNode.modelMeta?.[m.name]?.fetchedAt;
    });
    if (missing.length === 0) return;
    let cancelled = false;
    (async () => {
      for (const m of missing.slice(0, 8)) {
        if (cancelled) break;
        await inspectModel(currentNode, m.name);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [isOpen, currentNode?.id, currentNode?.online, currentNode?.models.map(m => m.name).join(',')]);

  if (!isOpen) return null;

  const handleUpdateHardware = (field: keyof HardwareProfile, value: any) => {
    if (!currentNode) return;
    const updated = nodes.map(n => {
      if (n.id === currentNode.id) {
        return {
          ...n,
          hardware: {
            ...n.hardware,
            [field]: value
          }
        };
      }
      return n;
    });
    onUpdateNodes(updated);
  };

  const handleUpdateNodeProp = (field: 'name' | 'url' | 'apiKey' | 'type', value: string) => {
    if (!currentNode) return;
    const updated = nodes.map(n => {
      if (n.id === currentNode.id) {
        return {
          ...n,
          [field]: value
        };
      }
      return n;
    });
    onUpdateNodes(updated);
  };

  const handleApplyGpuPreset = (presetName: string) => {
    const preset = GPU_PRESETS.find(p => p.name === presetName);
    if (!preset) return;
    handleUpdateHardware('gpu', preset.name);
    handleUpdateHardware('vramGB', preset.vramGB);
    handleUpdateHardware('gpuBandwidthGBs', preset.bandwidth);
  };

  const handleDetectHardware = async () => {
    if (!window.electronAPI) return;
    try {
      const detected = await window.electronAPI.detectHardware();
      if (!currentNode) return;
      const updated = nodes.map(n => {
        if (n.id === currentNode.id) {
          return {
            ...n,
            hardware: {
              ...n.hardware,
              cpu: detected.cpu || n.hardware.cpu,
              gpu: detected.gpu || n.hardware.gpu,
              vramGB: detected.vramGB || n.hardware.vramGB,
              ramGB: detected.ramGB || n.hardware.ramGB,
              ramBandwidthGBs: detected.ramBandwidthGBs || n.hardware.ramBandwidthGBs
            }
          };
        }
        return n;
      });
      onUpdateNodes(updated);
    } catch (err) {
      console.error('Failed to detect hardware:', err);
    }
  };

  const handleRunBenchmark = async (node: EndpointNode, modelName: string) => {
    if (!window.electronAPI) return;
    setBenchmarkingModel(modelName);
    setBenchmarkingNodeId(node.id);

    try {
      const res = await window.electronAPI.benchmarkModel(node, modelName);
      if (!res.error) {
        const measured = {
          ...res,
          provisional: false,
          measuredAt: Date.now()
        };
        const updated = nodes.map(n => {
          if (n.id === node.id) {
            const benchmarks = { ...(n.benchmarks || {}), [modelName]: measured };
            return { ...n, benchmarks };
          }
          return n;
        });
        onUpdateNodes(updated);
      } else {
        alert(`Benchmark failed: ${res.error}`);
      }
    } catch (err: any) {
      alert(`Benchmark error: ${err.message}`);
    } finally {
      setBenchmarkingModel(null);
      setBenchmarkingNodeId(null);
    }
  };

  const handlePullModel = (node: EndpointNode, tag: string) => {
    const key = `${node.id}:${tag}`;
    setPullProgress(prev => ({ ...prev, [key]: { status: 'Starting download...' } }));

    pullModel(node.url, tag, (status, completed, total) => {
      setPullProgress(prev => ({
        ...prev,
        [key]: { status, completed, total }
      }));
    }).done.then(async () => {
      await onRefreshNodes();
      // Discover thinking support + description from Ollama after download
      await inspectModel(node, tag);
      setTimeout(() => {
        setPullProgress(prev => {
          const next = { ...prev };
          delete next[key];
          return next;
        });
      }, 3000);
    }).catch(err => {
      setPullProgress(prev => ({
        ...prev,
        [key]: { status: `Failed: ${err.message}` }
      }));
    });
  };

  const handleDirectPull = (e: React.FormEvent) => {
    e.preventDefault();
    if (!customPullTag.trim() || !currentNode || isPullingCustom) return;

    const tag = customPullTag.trim();
    setIsPullingCustom(true);
    setCustomPullStatus(`Connecting to ${currentNode.name}...`);
    setCustomPullPercent(0);

    pullModel(currentNode.url, tag, (status, completed, total) => {
      let pct = null;
      let label = status;
      if (completed && total && total > 0) {
        pct = Math.round((completed / total) * 100);
        label = `${status} (${pct}% · ${(completed / 1e9).toFixed(1)} / ${(total / 1e9).toFixed(1)} GB)`;
      }
      setCustomPullStatus(label);
      setCustomPullPercent(pct);
    }).done.then(async () => {
      setCustomPullStatus('Pull complete! Inspecting model capabilities…');
      setCustomPullTag('');
      await onRefreshNodes();
      await inspectModel(currentNode, tag);
      setCustomPullStatus('Pull complete! Thinking controls available if the model supports them.');
      setTimeout(() => {
        setIsPullingCustom(false);
        setCustomPullStatus(null);
        setCustomPullPercent(null);
      }, 3500);
    }).catch(err => {
      setCustomPullStatus(`Failed: ${err.message}`);
      setTimeout(() => {
        setIsPullingCustom(false);
        setCustomPullStatus(null);
        setCustomPullPercent(null);
      }, 5000);
    });
  };

  const handleDeleteModelFromNode = async (node: EndpointNode, modelName: string) => {
    if (!confirm(`Are you sure you want to delete "${modelName}" from ${node.name}? This will permanently remove it from that computer's storage.`)) return;
    if (!window.electronAPI) return;
    try {
      const res = await window.electronAPI.deleteModel(node.url, modelName);
      if (res.success) {
        // Drop local bookkeeping so Conductor dropdowns don't keep ghost models
        const updated = nodes.map(n => {
          if (n.id !== node.id) return n;
          const { [modelName]: _removed, ...restBench } = n.benchmarks || {};
          const nextModels = (n.models || []).filter(m => m.name !== modelName);
          const remainingNames = nextModels
            .map(m => m.name)
            .filter(name => !isEmbeddingModelName(name) && !(n.disabledModels || []).includes(name));
          const nextActive =
            n.activeModel === modelName ? remainingNames[0] || undefined : n.activeModel;
          const { [modelName]: _m, ...restMeta } = n.modelMeta || {};
          const { [modelName]: _p, ...restPrefs } = n.modelPrefs || {};
          return {
            ...n,
            models: nextModels,
            benchmarks: restBench,
            modelMeta: restMeta,
            modelPrefs: restPrefs,
            activeModel: nextActive,
            disabledModels: (n.disabledModels || []).filter(d => d !== modelName)
          };
        });
        onUpdateNodes(updated);
        onRefreshNodes();
      } else {
        alert(`Delete failed: ${res.error}`);
      }
    } catch (err: any) {
      alert(`Delete error: ${err.message}`);
    }
  };

  const handleToggleModelEnabled = (node: EndpointNode, modelName: string) => {
    const disabledSet = new Set(node.disabledModels || []);
    if (disabledSet.has(modelName)) {
      disabledSet.delete(modelName);
    } else {
      disabledSet.add(modelName);
    }
    const nextDisabled = Array.from(disabledSet);

    const updated = nodes.map(n => {
      if (n.id === node.id) {
        let nextActive = n.activeModel;
        if (nextActive === modelName && disabledSet.has(modelName)) {
          const remaining = (n.models || [])
            .map(m => m.name)
            .filter(name => !disabledSet.has(name) && !name.toLowerCase().includes('embed') && !name.toLowerCase().includes('bge'));
          nextActive = remaining[0] || undefined;
        }
        return { ...n, disabledModels: nextDisabled, activeModel: nextActive };
      }
      return n;
    });
    onUpdateNodes(updated);
  };

  /** Enable or disable all generative models on the currently selected node only. */
  const handleSetAllModelsEnabled = (node: EndpointNode, enabled: boolean) => {
    const generative = (node.models || []).filter(m => {
      const isEmbed = m.capabilities?.includes('embedding') ||
        m.name.toLowerCase().includes('embed') ||
        m.name.toLowerCase().includes('bge');
      return !isEmbed;
    });
    if (generative.length === 0) return;

    const updated = nodes.map(n => {
      if (n.id !== node.id) return n;
      if (enabled) {
        const first = generative[0]?.name;
        const nextActive =
          n.activeModel && generative.some(m => m.name === n.activeModel)
            ? n.activeModel
            : first;
        return { ...n, disabledModels: [], activeModel: nextActive };
      }
      const allNames = generative.map(m => m.name);
      return { ...n, disabledModels: allNames, activeModel: undefined };
    });
    onUpdateNodes(updated);
  };

  const closeNodesIODialog = () => {
    setNodesIOMode(null);
    setNodesIOPassphrase('');
    setNodesIOConfirm('');
    setNodesIOMergeMode('replace');
    setNodesIOBusy(false);
    setNodesIOError(null);
  };

  const openNodesIODialog = (mode: 'export' | 'import') => {
    setNodesIOMode(mode);
    setNodesIOPassphrase('');
    setNodesIOConfirm('');
    setNodesIOMergeMode('replace');
    setNodesIOBusy(false);
    setNodesIOError(null);
  };

  const nodesToExportConfigs = (): NodeConfig[] =>
    nodes.map(n => {
      const { online: _o, latency: _l, models: _m, loaded: _ld, error: _e, ...cfg } = n;
      return cfg;
    });

  const handleNodesIOSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!window.electronAPI || !nodesIOMode) return;
    setNodesIOError(null);

    if (nodesIOPassphrase.length < 4) {
      setNodesIOError('Passphrase must be at least 4 characters');
      return;
    }
    if (nodesIOMode === 'export' && nodesIOPassphrase !== nodesIOConfirm) {
      setNodesIOError('Passphrases do not match');
      return;
    }

    setNodesIOBusy(true);
    try {
      if (nodesIOMode === 'export') {
        const res = await window.electronAPI.exportNodes(nodesToExportConfigs(), nodesIOPassphrase);
        if (res.canceled) {
          setNodesIOBusy(false);
          return;
        }
        if (res.error) {
          setNodesIOError(res.error);
          setNodesIOBusy(false);
          return;
        }
        closeNodesIODialog();
        return;
      }

      const res = await window.electronAPI.importNodes(nodesIOPassphrase);
      if (res.canceled) {
        setNodesIOBusy(false);
        return;
      }
      if (res.error || !res.nodes?.length) {
        setNodesIOError(res.error || 'No nodes in file');
        setNodesIOBusy(false);
        return;
      }

      const imported = res.nodes;
      let next: NodeConfig[];
      if (nodesIOMergeMode === 'replace') {
        next = imported;
      } else {
        const byId = new Map(nodesToExportConfigs().map(n => [n.id, n]));
        const byUrl = new Map(nodesToExportConfigs().map(n => [n.url, n.id]));
        for (const inc of imported) {
          const urlMatchId = byUrl.get(inc.url);
          if (byId.has(inc.id)) {
            byId.set(inc.id, { ...byId.get(inc.id)!, ...inc });
          } else if (urlMatchId && byId.has(urlMatchId)) {
            byId.set(urlMatchId, { ...byId.get(urlMatchId)!, ...inc, id: urlMatchId });
          } else {
            byId.set(inc.id, inc);
          }
        }
        next = Array.from(byId.values());
      }

      onUpdateNodes(next);
      if (next[0]?.id) setSelectedNodeId(next[0].id);
      closeNodesIODialog();
      onRefreshNodes();
    } catch (err: any) {
      setNodesIOError(err?.message || 'Operation failed');
      setNodesIOBusy(false);
    }
  };

  const handleSetPrimaryModel = (node: EndpointNode, modelName: string) => {
    const disabledSet = new Set(node.disabledModels || []);
    disabledSet.delete(modelName); // Ensure primary model is enabled
    const updated = nodes.map(n => {
      if (n.id === node.id) {
        return { ...n, activeModel: modelName, disabledModels: Array.from(disabledSet) };
      }
      return n;
    });
    onUpdateNodes(updated);
  };

  const handleToggleThinking = (node: EndpointNode, modelName: string, enabled: boolean) => {
    const updated = nodes.map(n => {
      if (n.id !== node.id) return n;
      return {
        ...n,
        modelPrefs: {
          ...(n.modelPrefs || {}),
          [modelName]: { ...(n.modelPrefs?.[modelName] || {}), think: enabled }
        }
      };
    });
    onUpdateNodes(updated);
  };

  const handleSetModelNumCtx = (node: EndpointNode, modelName: string, numCtx: number) => {
    const updated = nodes.map(n => {
      if (n.id !== node.id) return n;
      return {
        ...n,
        modelPrefs: {
          ...(n.modelPrefs || {}),
          [modelName]: { ...(n.modelPrefs?.[modelName] || {}), numCtx }
        }
      };
    });
    onUpdateNodes(updated);
  };

  const handleAddNodeSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!newNodeName.trim() || !newNodeUrl.trim()) return;

    const isFrontier = newNodeType === 'openai' || newNodeUrl.includes('x.ai') || newNodeUrl.includes('openai');
    const newNode: NodeConfig = {
      id: `node-${Date.now()}`,
      name: newNodeName.trim(),
      url: newNodeUrl.trim(),
      type: newNodeType,
      apiKey: newNodeApiKey.trim(),
      hardware: {
        cpu: isFrontier ? 'Cloud Cluster' : 'Generic CPU',
        gpu: isFrontier ? 'Frontier GPU Cluster' : 'Generic GPU',
        vramGB: isFrontier ? 80 : 8,
        gpuBandwidthGBs: isFrontier ? 3000 : 300,
        ramGB: isFrontier ? 128 : 16,
        ramBandwidthGBs: isFrontier ? 500 : 50,
        reserveVramGB: isFrontier ? 0 : 1,
        kvCacheType: 'f16'
      }
    };

    onUpdateNodes([...nodes, newNode]);
    setSelectedNodeId(newNode.id);
    setShowAddNode(false);
    setNewNodeName('');
    setNewNodeUrl('http://');
    setNewNodeApiKey('');
    setTimeout(onRefreshNodes, 200);
  };

  const handleDeleteNode = (id: string) => {
    if (confirm('Delete this endpoint node from cluster?')) {
      const filtered = nodes.filter(n => n.id !== id);
      onUpdateNodes(filtered);
      if (selectedNodeId === id) setSelectedNodeId(filtered[0]?.id || '');
    }
  };

  return (
    <div className="fixed inset-0 z-50 bg-black/70 backdrop-blur-xs flex items-center justify-center p-4">
      <div className="bg-[#161619] border border-[#2e2e38] w-full max-w-4xl rounded-xl shadow-2xl overflow-hidden flex flex-col h-[85vh]">
        {/* Header */}
        <div className="h-12 bg-[#121215] border-b border-[#27272a] px-4 flex items-center justify-between">
          <div className="flex items-center space-x-3">
            <div className="flex items-center space-x-2 text-indigo-400 font-bold text-sm">
              <Cpu className="w-4 h-4" />
              <span>Cluster & Hardware Conductor</span>
            </div>
            <div className="h-4 w-[1px] bg-[#27272a]" />
            <div className="flex items-center space-x-1 text-xs">
              <button
                onClick={() => setActiveTab('nodes')}
                className={`px-3 py-1 rounded transition ${
                  activeTab === 'nodes' ? 'bg-indigo-600 text-white font-medium' : 'text-zinc-400 hover:text-white'
                }`}
              >
                Hardware Nodes ({nodes.length})
              </button>
              <button
                onClick={() => setActiveTab('hub')}
                className={`px-3 py-1 rounded transition ${
                  activeTab === 'hub' ? 'bg-indigo-600 text-white font-medium' : 'text-zinc-400 hover:text-white'
                }`}
              >
                Model Hub & Recommendations
              </button>
              <button
                onClick={() => setActiveTab('appearance')}
                className={`flex items-center space-x-1.5 px-3 py-1 rounded transition ${
                  activeTab === 'appearance' ? 'bg-indigo-600 text-white font-medium' : 'text-zinc-400 hover:text-white'
                }`}
              >
                <Sliders className="w-3.5 h-3.5" />
                <span>Appearance & Scaling</span>
              </button>
              <button
                onClick={() => setActiveTab('stats')}
                className={`px-3 py-1 rounded transition ${
                  activeTab === 'stats' ? 'bg-indigo-600 text-white font-medium' : 'text-zinc-400 hover:text-white'
                }`}
              >
                Token Usage & Savings
              </button>
            </div>
          </div>

          <div className="flex items-center space-x-2">
            <button
              onClick={onRefreshNodes}
              className="flex items-center space-x-1 px-2.5 py-1 text-xs text-zinc-300 hover:text-white bg-[#1e1e24] hover:bg-[#282830] rounded border border-[#2c2c36] transition"
              title="Ping all endpoints"
            >
              <RefreshCw className="w-3 h-3" />
              <span>Ping All</span>
            </button>
            <button onClick={onClose} className="p-1 text-zinc-400 hover:text-white rounded">
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>

        {/* Tab 1: Hardware Nodes Configuration & Benchmarking */}
        {activeTab === 'nodes' && (
          <div className="flex-1 flex flex-col overflow-hidden">
            <div className="px-3 py-2 border-b border-[#27272a] flex items-center gap-2">
              <label className="text-[10px] uppercase tracking-wide text-zinc-500 shrink-0" htmlFor="searxng-url">
                SearXNG
              </label>
              <input
                id="searxng-url"
                type="text"
                value={searxngUrl}
                placeholder="http://127.0.0.1:8080"
                onChange={e => onUpdateSearxngUrl(e.target.value.trim())}
                className="min-w-0 flex-1 select-text bg-[#18181d] border border-[#2c2c38] text-zinc-200 rounded px-2 py-1 text-[11px] font-mono"
              />
            </div>
            <div className="flex-1 flex overflow-hidden">
            {/* Left Node Sidebar */}
            <div className="w-64 border-r border-[#27272a] bg-[#121215] flex flex-col justify-between p-2">
              <div className="space-y-1 overflow-y-auto">
                <div className="text-[10px] uppercase font-bold text-zinc-500 px-2 py-1 tracking-wider">
                  Configured Endpoints
                </div>
                {nodes.map(n => {
                  const isFrontier = n.type === 'openai' || !!n.apiKey;
                  return (
                    <div
                      key={n.id}
                      onClick={() => setSelectedNodeId(n.id)}
                      className={`p-2.5 rounded-lg cursor-pointer transition text-xs flex flex-col space-y-1 ${
                        selectedNodeId === n.id
                          ? 'bg-indigo-600/20 border border-indigo-500/40 text-white'
                          : 'bg-[#18181d] border border-transparent text-zinc-300 hover:bg-[#202026]'
                      }`}
                    >
                      <div className="flex items-center justify-between">
                        <span className="font-semibold truncate">{n.name}</span>
                        <span
                          className={`w-2 h-2 rounded-full ${
                            n.online ? 'bg-emerald-400 shadow-[0_0_6px_rgba(52,211,153,0.6)]' : 'bg-red-500'
                          }`}
                        />
                      </div>
                      <div className="flex items-center justify-between text-[10px] text-zinc-400 font-mono">
                        <span className="truncate">{isFrontier ? 'Frontier API' : `${n.hardware.vramGB}GB VRAM`}</span>
                        {n.online && n.latency !== null && (
                          <span className="text-emerald-400">{n.latency}ms</span>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>

              <div className="space-y-1.5 pt-2 border-t border-[#27272a]">
                <div className="grid grid-cols-2 gap-1.5">
                  <button
                    type="button"
                    onClick={() => openNodesIODialog('export')}
                    disabled={nodes.length === 0}
                    className="py-1.5 px-1.5 border border-[#2d2d38] hover:border-indigo-500/60 text-zinc-400 hover:text-indigo-200 text-[10px] rounded-lg flex items-center justify-center space-x-1 transition disabled:opacity-40"
                    title="Save encrypted backup of node setup (names, URLs, API keys, models prefs)"
                  >
                    <Download className="w-3 h-3 shrink-0" />
                    <span>Export</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => openNodesIODialog('import')}
                    className="py-1.5 px-1.5 border border-[#2d2d38] hover:border-indigo-500/60 text-zinc-400 hover:text-indigo-200 text-[10px] rounded-lg flex items-center justify-center space-x-1 transition"
                    title="Restore node setup from an encrypted .enc backup"
                  >
                    <Upload className="w-3 h-3 shrink-0" />
                    <span>Import</span>
                  </button>
                </div>
                <button
                  onClick={() => setShowAddNode(true)}
                  className="w-full py-2 border border-dashed border-[#2d2d38] hover:border-indigo-500 text-zinc-400 hover:text-indigo-300 text-xs rounded-lg flex items-center justify-center space-x-1.5 transition"
                >
                  <Plus className="w-3.5 h-3.5" />
                  <span>Add Node / Frontier API</span>
                </button>
              </div>
            </div>

            {/* Right Node Configuration Panel */}
            <div className="flex-1 p-5 overflow-y-auto space-y-5">
              {currentNode && (
                <>
                  {/* Node Identity & Connection */}
                  <div className="bg-[#121215] border border-[#272730] rounded-xl p-4 space-y-3">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center space-x-2">
                        <span className="text-sm font-bold text-zinc-100">{currentNode.name}</span>
                        {currentNode.type === 'openai' ? (
                          <span className="text-[10px] bg-sky-500/20 text-sky-300 border border-sky-500/30 px-2 py-0.5 rounded font-mono">
                            Frontier API (OpenAI Compatible)
                          </span>
                        ) : (
                          <span className="text-[10px] bg-emerald-500/20 text-emerald-300 border border-emerald-500/30 px-2 py-0.5 rounded font-mono">
                            Local Ollama Node
                          </span>
                        )}
                      </div>

                      <button
                        onClick={() => handleDeleteNode(currentNode.id)}
                        className="text-xs text-red-400 hover:text-red-300 flex items-center space-x-1 p-1"
                        title="Delete node"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                        <span>Delete</span>
                      </button>
                    </div>

                    <div className="grid grid-cols-2 gap-3 text-xs">
                      <div>
                        <label className="text-[11px] text-zinc-400 font-medium">Node Display Name</label>
                        <input
                          type="text"
                          value={currentNode.name}
                          onChange={(e) => handleUpdateNodeProp('name', e.target.value)}
                          className="w-full mt-1 bg-[#1a1a20] border border-[#2a2a36] text-zinc-200 rounded px-2.5 py-1.5 outline-none font-sans"
                        />
                      </div>
                      <div>
                        <label className="text-[11px] text-zinc-400 font-medium">Endpoint URL</label>
                        <input
                          type="text"
                          value={currentNode.url}
                          onChange={(e) => handleUpdateNodeProp('url', e.target.value)}
                          className="w-full mt-1 bg-[#1a1a20] border border-[#2a2a36] text-zinc-200 rounded px-2.5 py-1.5 outline-none font-mono text-[11px]"
                        />
                      </div>
                    </div>

                    {/* API Key for Frontier (Gemini / Grok / OpenAI / OpenRouter) */}
                    {(currentNode.type === 'openai' || currentNode.apiKey !== undefined) && (
                      <div>
                        <label className="text-[11px] text-zinc-400 font-medium flex items-center space-x-1">
                          <Key className="w-3 h-3 text-amber-400" />
                          <span>API Key (Google Gemini / xAI Grok / OpenAI / OpenRouter)</span>
                        </label>
                        <input
                          type="password"
                          placeholder={
                            currentNode.url?.includes('googleapis.com')
                              ? 'AIzaSy... (Gemini API Key)'
                              : 'xai-... or sk-...'
                          }
                          value={currentNode.apiKey || ''}
                          onChange={(e) => handleUpdateNodeProp('apiKey', e.target.value)}
                          className="w-full mt-1 bg-[#1a1a20] border border-[#2a2a36] text-zinc-200 rounded px-2.5 py-1.5 outline-none font-mono text-[11px]"
                        />
                        <p className="text-[10px] text-zinc-500 mt-1">
                          Stored only on this PC under %APPDATA%\LocalAgents Studio\settings.json — never inside the EXE. Plaintext, not encrypted.
                        </p>
                      </div>
                    )}
                  </div>

                  {/* Hardware Specs & Presets */}
                  {currentNode.type !== 'openai' && (
                    <div className="bg-[#121215] border border-[#272730] rounded-xl p-4 space-y-4">
                      <div className="flex items-center justify-between">
                        <div className="flex items-center space-x-2 text-xs font-bold text-zinc-200">
                          <Sliders className="w-4 h-4 text-indigo-400" />
                          <span>Compute & Memory Characteristics</span>
                        </div>

                        {currentNode.id === 'main-rig' && (
                          <button
                            onClick={handleDetectHardware}
                            className="text-[11px] text-indigo-300 hover:text-white bg-indigo-600/20 hover:bg-indigo-600/40 border border-indigo-500/30 px-2.5 py-1 rounded transition"
                          >
                            Auto-Detect This PC's Hardware
                          </button>
                        )}
                      </div>

                      {/* GPU Quick Presets */}
                      <div className="space-y-1.5">
                        <label className="text-[11px] text-zinc-400">Apply GPU Preset:</label>
                        <div className="flex flex-wrap gap-1.5">
                          {GPU_PRESETS.slice(0, 10).map(p => (
                            <button
                              key={p.name}
                              onClick={() => handleApplyGpuPreset(p.name)}
                              className={`px-2 py-0.5 rounded text-[10px] border transition ${
                                currentNode.hardware.gpu.includes(p.name)
                                  ? 'bg-indigo-600 text-white border-indigo-500'
                                  : 'bg-[#1a1a20] border-[#2b2b36] text-zinc-400 hover:text-zinc-200'
                              }`}
                            >
                              {p.name}
                            </button>
                          ))}
                        </div>
                      </div>

                      {/* Detailed Hardware Inputs */}
                      <div className="grid grid-cols-3 gap-3 text-xs">
                        <div>
                          <label className="text-[11px] text-zinc-400">GPU Model</label>
                          <input
                            type="text"
                            value={currentNode.hardware.gpu}
                            onChange={(e) => handleUpdateHardware('gpu', e.target.value)}
                            className="w-full mt-1 bg-[#1a1a20] border border-[#2a2a36] text-zinc-200 rounded px-2.5 py-1 outline-none font-mono"
                          />
                        </div>
                        <div>
                          <label className="text-[11px] text-zinc-400">VRAM (GB)</label>
                          <input
                            type="number"
                            value={currentNode.hardware.vramGB}
                            onChange={(e) => handleUpdateHardware('vramGB', parseFloat(e.target.value) || 0)}
                            className="w-full mt-1 bg-[#1a1a20] border border-[#2a2a36] text-zinc-200 rounded px-2.5 py-1 outline-none font-mono"
                          />
                        </div>
                        <div>
                          <label className="text-[11px] text-zinc-400">GPU Bandwidth (GB/s)</label>
                          <input
                            type="number"
                            value={currentNode.hardware.gpuBandwidthGBs}
                            onChange={(e) => handleUpdateHardware('gpuBandwidthGBs', parseFloat(e.target.value) || 0)}
                            className="w-full mt-1 bg-[#1a1a20] border border-[#2a2a36] text-zinc-200 rounded px-2.5 py-1 outline-none font-mono"
                          />
                        </div>

                        <div>
                          <label className="text-[11px] text-zinc-400">System RAM (GB)</label>
                          <input
                            type="number"
                            value={currentNode.hardware.ramGB}
                            onChange={(e) => handleUpdateHardware('ramGB', parseFloat(e.target.value) || 0)}
                            className="w-full mt-1 bg-[#1a1a20] border border-[#2a2a36] text-zinc-200 rounded px-2.5 py-1 outline-none font-mono"
                          />
                        </div>
                        <div>
                          <label className="text-[11px] text-zinc-400">RAM Bandwidth (GB/s)</label>
                          <input
                            type="number"
                            value={currentNode.hardware.ramBandwidthGBs}
                            onChange={(e) => handleUpdateHardware('ramBandwidthGBs', parseFloat(e.target.value) || 0)}
                            className="w-full mt-1 bg-[#1a1a20] border border-[#2a2a36] text-zinc-200 rounded px-2.5 py-1 outline-none font-mono"
                          />
                        </div>
                        <div>
                          <label className="text-[11px] text-zinc-400">Reserved VRAM (GB)</label>
                          <input
                            type="number"
                            step="0.1"
                            value={currentNode.hardware.reserveVramGB}
                            onChange={(e) => handleUpdateHardware('reserveVramGB', parseFloat(e.target.value) || 0)}
                            className="w-full mt-1 bg-[#1a1a20] border border-[#2a2a36] text-zinc-200 rounded px-2.5 py-1 outline-none font-mono"
                          />
                        </div>
                      </div>
                    </div>
                  )}

                  <InstalledModelsPanel
                    currentNode={currentNode}
                    benchmarkingModel={benchmarkingModel}
                    benchmarkingNodeId={benchmarkingNodeId}
                    customPullTag={customPullTag}
                    onCustomPullTagChange={setCustomPullTag}
                    isPullingCustom={isPullingCustom}
                    customPullStatus={customPullStatus}
                    customPullPercent={customPullPercent}
                    onDirectPull={handleDirectPull}
                    onToggleModelEnabled={handleToggleModelEnabled}
                    onSetAllModelsEnabled={handleSetAllModelsEnabled}
                    onSetPrimaryModel={handleSetPrimaryModel}
                    onRunBenchmark={handleRunBenchmark}
                    onDeleteModel={handleDeleteModelFromNode}
                    onToggleThinking={handleToggleThinking}
                    onSetModelNumCtx={handleSetModelNumCtx}
                    onInspectModel={inspectModel}
                    inspectingModel={inspectingModel}
                  />
                </>
              )}
              {!currentNode && (
                <div className="h-full flex flex-col items-center justify-center text-center px-8 text-zinc-500">
                  <Cpu className="w-10 h-10 text-indigo-400/50 mb-3" />
                  <p className="text-sm font-semibold text-zinc-200">No endpoints configured</p>
                  <p className="text-xs mt-2 max-w-sm leading-relaxed">
                    Add a local Ollama node (e.g. <code className="text-indigo-300">http://127.0.0.1:11434</code>) or a Frontier API to get started.
                  </p>
                  <button
                    onClick={() => setShowAddNode(true)}
                    className="mt-4 px-3 py-1.5 bg-indigo-600 hover:bg-indigo-500 text-white text-xs rounded-lg flex items-center space-x-1.5 transition"
                  >
                    <Plus className="w-3.5 h-3.5" />
                    <span>Add Node / Frontier API</span>
                  </button>
                </div>
              )}

              {!currentNode && (
                <div className="h-full flex flex-col items-center justify-center text-center p-8 text-zinc-500">
                  <Cpu className="w-10 h-10 text-indigo-400/40 mb-3" />
                  <p className="text-sm font-semibold text-zinc-200">No endpoints configured</p>
                  <p className="text-xs text-zinc-400 mt-1 max-w-sm">
                    Connect your local Ollama instance (default: <code className="text-indigo-300">http://127.0.0.1:11434</code>) or a remote GPU endpoint to start running agents.
                  </p>
                  <button
                    type="button"
                    onClick={() => setShowAddNode(true)}
                    className="mt-4 px-4 py-2 bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-medium rounded-lg transition shadow flex items-center space-x-1.5"
                  >
                    <Plus className="w-4 h-4" />
                    <span>Add Node / Frontier API</span>
                  </button>
                </div>
              )}
            </div>
            </div>
          </div>
        )}
        {activeTab === 'hub' && (
          currentNode ? (
            <ModelHubPanel
              nodes={nodes}
              currentNode={currentNode}
              selectedNodeId={selectedNodeId}
              onSelectNodeId={setSelectedNodeId}
              selectedTask={selectedTask}
              onSelectTask={setSelectedTask}
              estimateContext={estimateContext}
              onUpdateEstimateContext={onUpdateEstimateContext}
              pullProgress={pullProgress}
              onPullModel={handlePullModel}
            />
          ) : (
            <div className="flex-1 flex flex-col items-center justify-center text-center px-8 text-zinc-500">
              <p className="text-sm font-semibold text-zinc-200">Add a node first</p>
              <p className="text-xs mt-2">Model Hub needs at least one endpoint to recommend pulls.</p>
              <button
                onClick={() => {
                  setActiveTab('nodes');
                  setShowAddNode(true);
                }}
                className="mt-4 px-3 py-1.5 bg-indigo-600 hover:bg-indigo-500 text-white text-xs rounded-lg transition"
              >
                Add Node
              </button>
            </div>
          )
        )}

        {/* Tab 3: Appearance & Scaling */}
        {activeTab === 'appearance' && (
          <div className="flex-1 p-6 flex flex-col space-y-6 overflow-y-auto">
            <div>
              <h3 className="text-sm font-bold text-zinc-100 flex items-center space-x-2">
                <Sliders className="w-4 h-4 text-indigo-400" />
                <span>UI & Text Scaling</span>
              </h3>
              <p className="text-xs text-zinc-400 mt-1 leading-relaxed">
                Adjust the scaling slider to make text, chat containers, and code editor comfortable on higher resolution screens (such as 1440p, 4K, or high-DPI laptops).
              </p>
            </div>

            {/* Main Scaling Slider Box */}
            <div className="bg-[#121215] border border-[#272730] rounded-xl p-5 space-y-4">
              <div className="flex items-center justify-between">
                <span className="text-xs font-semibold text-zinc-200">Scale Factor</span>
                <span className="text-sm font-bold font-mono text-indigo-400 bg-indigo-950/60 px-3 py-0.5 rounded border border-indigo-500/30">
                  {Math.round(uiScale * 100)}%
                </span>
              </div>

              {/* Slider */}
              <div className="space-y-2">
                <input
                  type="range"
                  min="0.75"
                  max="1.75"
                  step="0.05"
                  value={uiScale}
                  onChange={(e) => onUpdateUiScale(parseFloat(e.target.value))}
                  className="w-full accent-indigo-500 cursor-pointer h-2 bg-[#25252e] rounded-lg"
                />
                <div className="flex justify-between text-[10px] text-zinc-500 font-mono">
                  <span>75% (Compact)</span>
                  <span>100% (Default)</span>
                  <span>125% (1440p)</span>
                  <span>150% (4K)</span>
                  <span>175% (Large)</span>
                </div>
              </div>

              {/* Preset buttons */}
              <div className="grid grid-cols-6 gap-2 pt-1 text-xs">
                {[
                  { label: '80%', val: 0.8 },
                  { label: '100% (Default)', val: 1.0 },
                  { label: '115%', val: 1.15 },
                  { label: '125% (HiDPI)', val: 1.25 },
                  { label: '150% (4K)', val: 1.5 },
                  { label: '175%', val: 1.75 }
                ].map(item => (
                  <button
                    key={item.val}
                    type="button"
                    onClick={() => onUpdateUiScale(item.val)}
                    className={`py-1.5 px-2 rounded font-mono text-center transition border ${
                      Math.abs(uiScale - item.val) < 0.02
                        ? 'bg-indigo-600 text-white border-indigo-500 font-bold shadow'
                        : 'bg-[#18181d] text-zinc-400 hover:text-white border-[#272732] hover:bg-[#202026]'
                    }`}
                  >
                    {item.label}
                  </button>
                ))}
              </div>
            </div>

            {/* Live Interactive Preview Container */}
            <div className="space-y-2">
              <span className="text-xs font-semibold text-zinc-300">Live Appearance Preview</span>
              <div className="bg-[#121215] border border-[#272730] rounded-xl p-4 space-y-3">
                {/* Sample Chat Message */}
                <div className="flex items-start space-x-2.5">
                  <div className="w-6 h-6 rounded-full bg-indigo-600 flex items-center justify-center text-[10px] font-bold text-white shrink-0">
                    AI
                  </div>
                  <div className="flex-1 bg-[#1e1e24] border border-[#2b2b36] rounded-lg p-3 space-y-2 text-xs leading-relaxed text-zinc-200">
                    <p className="font-semibold text-indigo-300">Agent Conductor</p>
                    <p>I inspected your project and generated the native application files. Here is the implementation:</p>
                    <div className="bg-[#121215] border border-[#2a2a36] rounded p-2 font-mono text-[11px] text-zinc-400">
                      <code>&lt;write_file path="src/main.py"&gt;</code>
                    </div>
                  </div>
                </div>

                <div className="flex items-center justify-between pt-2 border-t border-[#272730] text-[11px] text-zinc-500">
                  <span>Keyboard shortcuts: <kbd className="px-1.5 py-0.5 bg-[#1e1e24] rounded border border-[#30303c] font-mono text-zinc-300">Ctrl +</kbd> to zoom in, <kbd className="px-1.5 py-0.5 bg-[#1e1e24] rounded border border-[#30303c] font-mono text-zinc-300">Ctrl -</kbd> to zoom out, <kbd className="px-1.5 py-0.5 bg-[#1e1e24] rounded border border-[#30303c] font-mono text-zinc-300">Ctrl 0</kbd> to reset.</span>
                  {Math.round(uiScale * 100) !== 100 && (
                    <button
                      type="button"
                      onClick={() => onUpdateUiScale(1.0)}
                      className="text-indigo-400 hover:text-indigo-300 font-medium"
                    >
                      Reset to 100%
                    </button>
                  )}
                </div>
              </div>
            </div>
          </div>
        )}

        {/* Tab 4: Token Usage & Local Savings */}
        {activeTab === 'stats' && (
          <div className="flex-1 p-6 flex flex-col space-y-6 overflow-y-auto">
            <div className="bg-[#121215] border border-[#272730] rounded-xl p-4 space-y-2">
              <h3 className="text-sm font-bold text-zinc-100">Local settings (not in the EXE)</h3>
              <p className="text-xs text-zinc-400 leading-relaxed">
                Endpoints, API keys, chats, and layout are saved per Windows user under AppData. Shipping or copying the portable EXE does not include your machine config. Use Export / Import on the Hardware Nodes tab for an encrypted node backup across rebuilds.
              </p>
              <code className="block text-[10px] font-mono text-indigo-300/90 break-all bg-[#0e0e11] rounded px-2 py-1.5 border border-[#2a2a34]">
                {settingsFilePath || '%APPDATA%\\LocalAgents Studio\\settings.json'}
              </code>
              <button
                type="button"
                onClick={() => window.electronAPI?.openSettingsFolder()}
                className="inline-flex items-center space-x-1.5 px-2.5 py-1 text-[11px] text-zinc-200 bg-[#1e1e24] hover:bg-[#282830] border border-[#2c2c36] rounded transition"
              >
                <FolderOpen className="w-3.5 h-3.5 text-indigo-400" />
                <span>Open settings folder</span>
              </button>
            </div>

            <div>
              <h3 className="text-sm font-bold text-zinc-100">Local Agent Token Economy</h3>
              <p className="text-xs text-zinc-400 mt-1">
                LocalAgents runs heavy agent loops on your local Ollama GPUs without API charges.
              </p>
            </div>

            <div className="grid grid-cols-3 gap-4">
              <div className="bg-[#121215] border border-[#272730] rounded-xl p-4 space-y-1">
                <span className="text-[11px] text-zinc-400 font-medium">Free Local Tokens Generated</span>
                <div className="text-2xl font-bold font-mono text-emerald-400">
                  {localTokens.toLocaleString()}
                </div>
                <p className="text-[10px] text-zinc-500">Processed entirely on your local GPUs</p>
              </div>

              <div className="bg-[#121215] border border-[#272730] rounded-xl p-4 space-y-1">
                <span className="text-[11px] text-zinc-400 font-medium">Frontier Cloud Tokens Used</span>
                <div className="text-2xl font-bold font-mono text-sky-400">
                  {frontierTokens.toLocaleString()}
                </div>
                <p className="text-[10px] text-zinc-500">Grok / OpenAI / Frontier calls</p>
              </div>

              <div className="bg-[#121215] border border-emerald-500/30 bg-emerald-950/10 rounded-xl p-4 space-y-1">
                <span className="text-[11px] text-emerald-300 font-medium">Estimated API Cost Saved</span>
                <div className="text-2xl font-bold font-mono text-emerald-300">
                  ${((localTokens / 1000000) * 15).toFixed(2)}
                </div>
                <p className="text-[10px] text-emerald-500/80">Based on standard frontier token rates</p>
              </div>
            </div>
          </div>
        )}

        {/* Add Node Dialog */}
        {showAddNode && (
          <div className="absolute inset-0 bg-black/80 backdrop-blur-xs flex items-center justify-center p-4 z-50">
            <form
              onSubmit={handleAddNodeSubmit}
              className="bg-[#18181d] border border-[#30303e] rounded-xl p-5 w-full max-w-md space-y-4 shadow-2xl"
            >
              <div className="flex items-center justify-between">
                <span className="text-sm font-bold text-zinc-100">Register Endpoint Node</span>
                <button
                  type="button"
                  onClick={() => setShowAddNode(false)}
                  className="p-1 text-zinc-400 hover:text-white"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>

              <div className="space-y-3 text-xs">
                <div>
                  <label className="text-[11px] text-zinc-400 block mb-1.5 font-medium">Quick Presets / Templates</label>
                  <div className="flex flex-wrap gap-1.5">
                    {[
                      { label: 'Google Gemini', type: 'openai' as const, name: 'Google Gemini', url: 'https://generativelanguage.googleapis.com/v1beta/openai/' },
                      { label: 'xAI Grok', type: 'openai' as const, name: 'xAI Grok', url: 'https://api.x.ai/v1' },
                      { label: 'OpenAI', type: 'openai' as const, name: 'OpenAI', url: 'https://api.openai.com/v1' },
                      { label: 'OpenRouter', type: 'openai' as const, name: 'OpenRouter', url: 'https://openrouter.ai/api/v1' },
                      { label: 'Local Ollama', type: 'ollama' as const, name: 'Local Ollama', url: 'http://localhost:11434' },
                    ].map((preset) => (
                      <button
                        key={preset.label}
                        type="button"
                        onClick={() => {
                          setNewNodeType(preset.type);
                          setNewNodeName(preset.name);
                          setNewNodeUrl(preset.url);
                        }}
                        className="px-2 py-1 rounded bg-[#1f1f28] hover:bg-[#2c2c3b] border border-[#2e2e3e] text-[10px] text-zinc-300 hover:text-white font-medium transition-colors"
                      >
                        + {preset.label}
                      </button>
                    ))}
                  </div>
                </div>

                <div>
                  <label className="text-[11px] text-zinc-400">Endpoint Type</label>
                  <select
                    value={newNodeType}
                    onChange={(e) => setNewNodeType(e.target.value as any)}
                    className="w-full mt-1 bg-[#121215] border border-[#2a2a36] text-zinc-200 rounded px-2.5 py-1.5 outline-none"
                  >
                    <option value="ollama">Local / LAN Ollama Node</option>
                    <option value="openai">Frontier API (Google Gemini, xAI Grok, OpenAI, OpenRouter)</option>
                  </select>
                </div>

                <div>
                  <label className="text-[11px] text-zinc-400">Node Name</label>
                  <input
                    type="text"
                    placeholder="e.g. Google Gemini, xAI Grok, or Linux Box 2"
                    value={newNodeName}
                    onChange={(e) => setNewNodeName(e.target.value)}
                    required
                    className="w-full mt-1 bg-[#121215] border border-[#2a2a36] text-zinc-200 rounded px-2.5 py-1.5 outline-none"
                  />
                </div>

                <div>
                  <label className="text-[11px] text-zinc-400">URL</label>
                  <input
                    type="text"
                    placeholder={
                      newNodeType === 'openai'
                        ? 'https://generativelanguage.googleapis.com/v1beta/openai/ or https://api.x.ai/v1'
                        : 'http://192.168.1.xxx:11434'
                    }
                    value={newNodeUrl}
                    onChange={(e) => setNewNodeUrl(e.target.value)}
                    required
                    className="w-full mt-1 bg-[#121215] border border-[#2a2a36] text-zinc-200 rounded px-2.5 py-1.5 outline-none font-mono text-[11px]"
                  />
                </div>

                {newNodeType === 'openai' && (
                  <div>
                    <label className="text-[11px] text-zinc-400">API Key</label>
                    <input
                      type="password"
                      placeholder={
                        newNodeUrl.includes('googleapis.com')
                          ? 'AIzaSy... (Gemini API Key)'
                          : 'xai-... or sk-...'
                      }
                      value={newNodeApiKey}
                      onChange={(e) => setNewNodeApiKey(e.target.value)}
                      className="w-full mt-1 bg-[#121215] border border-[#2a2a36] text-zinc-200 rounded px-2.5 py-1.5 outline-none font-mono text-[11px]"
                    />
                  </div>
                )}
              </div>

              <div className="flex items-center justify-end space-x-2 pt-2">
                <button
                  type="button"
                  onClick={() => setShowAddNode(false)}
                  className="px-3 py-1.5 text-zinc-400 hover:text-white text-xs"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="px-4 py-1.5 bg-indigo-600 hover:bg-indigo-500 text-white rounded text-xs font-medium"
                >
                  Save Node
                </button>
              </div>
            </form>
          </div>
        )}

        {/* Encrypted Export / Import passphrase dialog */}
        {nodesIOMode && (
          <div className="absolute inset-0 bg-black/80 backdrop-blur-xs flex items-center justify-center p-4 z-50">
            <form
              onSubmit={handleNodesIOSubmit}
              className="bg-[#18181d] border border-[#30303e] rounded-xl p-5 w-full max-w-sm space-y-3.5 shadow-2xl"
            >
              <div className="flex items-center justify-between">
                <div className="flex items-center space-x-2 text-sm font-bold text-zinc-100">
                  <Lock className="w-4 h-4 text-amber-400" />
                  <span>{nodesIOMode === 'export' ? 'Export nodes (encrypted)' : 'Import nodes (encrypted)'}</span>
                </div>
                <button type="button" onClick={closeNodesIODialog} className="p-1 text-zinc-400 hover:text-white">
                  <X className="w-4 h-4" />
                </button>
              </div>

              <p className="text-[11px] text-zinc-400 leading-relaxed">
                {nodesIOMode === 'export'
                  ? 'Saves node names, URLs, API keys, models prefs, roles, and benchmarks into a passphrase-locked .enc file. Layout and workspace path are not included.'
                  : 'Decrypt a .enc backup and restore cluster nodes. Choose replace (typical after a new EXE) or merge by id/url.'}
              </p>

              <div>
                <label className="text-[11px] text-zinc-400 font-medium">Passphrase</label>
                <input
                  type="password"
                  autoFocus
                  autoComplete="new-password"
                  value={nodesIOPassphrase}
                  onChange={(e) => setNodesIOPassphrase(e.target.value)}
                  className="w-full mt-1 bg-[#121215] border border-[#2a2a36] text-zinc-200 rounded px-2.5 py-1.5 outline-none text-xs"
                  placeholder="Min. 4 characters"
                />
              </div>

              {nodesIOMode === 'export' && (
                <div>
                  <label className="text-[11px] text-zinc-400 font-medium">Confirm passphrase</label>
                  <input
                    type="password"
                    autoComplete="new-password"
                    value={nodesIOConfirm}
                    onChange={(e) => setNodesIOConfirm(e.target.value)}
                    className="w-full mt-1 bg-[#121215] border border-[#2a2a36] text-zinc-200 rounded px-2.5 py-1.5 outline-none text-xs"
                  />
                </div>
              )}

              {nodesIOMode === 'import' && (
                <div className="space-y-1.5">
                  <span className="text-[11px] text-zinc-400 font-medium">On import</span>
                  <label className="flex items-start space-x-2 text-[11px] text-zinc-300 cursor-pointer">
                    <input
                      type="radio"
                      name="nodes-io-merge"
                      checked={nodesIOMergeMode === 'replace'}
                      onChange={() => setNodesIOMergeMode('replace')}
                      className="mt-0.5"
                    />
                    <span>
                      <span className="font-medium text-zinc-200">Replace all nodes</span>
                      <span className="block text-zinc-500">Best for restore after a new build</span>
                    </span>
                  </label>
                  <label className="flex items-start space-x-2 text-[11px] text-zinc-300 cursor-pointer">
                    <input
                      type="radio"
                      name="nodes-io-merge"
                      checked={nodesIOMergeMode === 'merge'}
                      onChange={() => setNodesIOMergeMode('merge')}
                      className="mt-0.5"
                    />
                    <span>
                      <span className="font-medium text-zinc-200">Merge by id / URL</span>
                      <span className="block text-zinc-500">Keep existing nodes; overwrite matches</span>
                    </span>
                  </label>
                </div>
              )}

              {nodesIOError && (
                <p className="text-[11px] text-red-400 bg-red-950/30 border border-red-500/30 rounded px-2.5 py-1.5">
                  {nodesIOError}
                </p>
              )}

              <div className="flex items-center justify-end space-x-2 pt-1">
                <button
                  type="button"
                  onClick={closeNodesIODialog}
                  disabled={nodesIOBusy}
                  className="px-3 py-1.5 text-zinc-400 hover:text-white text-xs disabled:opacity-50"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={nodesIOBusy || !nodesIOPassphrase}
                  className="px-4 py-1.5 bg-indigo-600 hover:bg-indigo-500 disabled:opacity-40 text-white rounded text-xs font-medium flex items-center space-x-1.5"
                >
                  {nodesIOBusy ? <RefreshCw className="w-3 h-3 animate-spin" /> : null}
                  <span>{nodesIOMode === 'export' ? 'Choose save location…' : 'Choose file…'}</span>
                </button>
              </div>
            </form>
          </div>
        )}
      </div>
    </div>
  );
};
