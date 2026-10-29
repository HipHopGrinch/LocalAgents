import React from 'react';
import { EndpointNode } from '../types';
import { Folder, FolderPlus, Cpu, RefreshCw, Terminal, Layers, Zap, Cloud } from 'lucide-react';

interface HeaderProps {
  workspacePath: string;
  onSelectFolder: () => void;
  onNewProject: () => void;
  nodes: EndpointNode[];
  onRefreshNodes: () => void;
  isTerminalOpen: boolean;
  onToggleTerminal: () => void;
  onOpenHardwareModal: () => void;
  localTokens: number;
  frontierTokens: number;
}

export const Header: React.FC<HeaderProps> = ({
  workspacePath,
  onSelectFolder,
  onNewProject,
  nodes,
  onRefreshNodes,
  isTerminalOpen,
  onToggleTerminal,
  onOpenHardwareModal,
  localTokens,
  frontierTokens
}) => {
  return (
    <header className="h-12 bg-[#121214] border-b border-[#27272a] px-4 flex items-center justify-between select-none shrink-0">
      {/* Brand & Workspace */}
      <div className="flex items-center space-x-3">
        <div className="flex items-center space-x-2 text-indigo-400 font-bold tracking-tight text-sm">
          <Layers className="w-5 h-5" />
          <span>LocalAgents Studio</span>
        </div>
        
        <div className="h-4 w-[1px] bg-[#27272a]" />

        <button
          onClick={onNewProject}
          className="flex items-center space-x-1.5 text-xs text-zinc-300 hover:text-white bg-[#1e1e24] hover:bg-indigo-600/30 border border-[#2e2e38] hover:border-indigo-500/50 px-2.5 py-1 rounded transition"
          title="New project: open a folder, clear editor tabs, start a fresh chat"
        >
          <FolderPlus className="w-3.5 h-3.5 text-indigo-400" />
          <span>New Project</span>
        </button>

        <button
          onClick={onSelectFolder}
          className="flex items-center space-x-2 text-xs text-zinc-300 hover:text-white bg-[#1e1e24] hover:bg-[#27272a] border border-[#2e2e38] px-2.5 py-1 rounded transition"
          title="Open a different project folder (keeps chat history for each folder)"
        >
          <Folder className="w-3.5 h-3.5 text-amber-400" />
          <span className="font-mono max-w-[260px] truncate">{workspacePath || 'No Folder Open'}</span>
        </button>
      </div>

      {/* Cluster Nodes & Token Economy */}
      <div className="flex items-center space-x-3">
        {/* Token Savings Pill */}
        <div 
          onClick={onOpenHardwareModal}
          className="flex items-center space-x-2 bg-[#18181d] border border-[#272732] px-2.5 py-1 rounded-full text-[11px] cursor-pointer hover:border-zinc-600 transition"
          title="Click to view token statistics & savings"
        >
          <div className="flex items-center space-x-1 text-emerald-400 font-mono">
            <Zap className="w-3 h-3" />
            <span>Local: {localTokens.toLocaleString()} tok</span>
          </div>
          <span className="text-zinc-600">•</span>
          <div className="flex items-center space-x-1 text-sky-400 font-mono">
            <Cloud className="w-3 h-3" />
            <span>Frontier: {frontierTokens.toLocaleString()} tok</span>
          </div>
        </div>

        {/* Cluster Status Bar */}
        <div 
          onClick={onOpenHardwareModal}
          className="flex items-center space-x-2 bg-[#18181b] border border-[#27272a] hover:border-zinc-700 px-2.5 py-1 rounded cursor-pointer transition"
          title="Click to configure hardware, model recommendations & benchmarks"
        >
          <Cpu className="w-3.5 h-3.5 text-zinc-400" />
          <span className="text-[11px] text-zinc-400 font-medium">Cluster:</span>
          
          <div className="flex items-center space-x-2">
            {nodes.map(node => (
              <div key={node.id} className="flex items-center space-x-1 text-[11px]">
                <span
                  className={`w-2 h-2 rounded-full ${
                    node.online ? 'bg-emerald-400 shadow-[0_0_6px_rgba(52,211,153,0.5)]' : 'bg-red-500/70'
                  }`}
                />
                <span className="text-zinc-300 font-mono text-[10px]">{node.name.split(' ')[0]}</span>
                {node.online && node.latency !== null && (
                  <span className="text-[9px] text-emerald-400 font-mono">{node.latency}ms</span>
                )}
              </div>
            ))}
          </div>
        </div>

        <button
          onClick={onRefreshNodes}
          className="p-1.5 text-zinc-400 hover:text-white hover:bg-[#27272a] rounded transition"
          title="Refresh cluster nodes status"
        >
          <RefreshCw className="w-3.5 h-3.5" />
        </button>

        <button
          onClick={onToggleTerminal}
          className={`flex items-center space-x-1.5 px-2.5 py-1 text-xs rounded border transition ${
            isTerminalOpen
              ? 'bg-indigo-600/20 border-indigo-500 text-indigo-300'
              : 'bg-[#18181b] border-[#27272a] text-zinc-400 hover:text-white'
          }`}
          title="Toggle PowerShell Terminal"
        >
          <Terminal className="w-3.5 h-3.5" />
          <span>Terminal</span>
        </button>
      </div>
    </header>
  );
};
