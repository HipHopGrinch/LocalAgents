import React, { useState, useRef, useEffect } from 'react';
import { EndpointNode } from '../types';
import { workspaceLabel, normalizeWorkspacePath } from '../lib/conversations';
import {
  Folder,
  FolderPlus,
  FolderOpen,
  ChevronDown,
  Cpu,
  RefreshCw,
  Terminal,
  Layers,
  Zap,
  Cloud,
  Sliders,
  RotateCcw
} from 'lucide-react';

interface HeaderProps {
  workspacePath: string;
  recentWorkspaces?: string[];
  onSelectFolder: () => void;
  onOpenRecent: (path: string) => void;
  onNewProject: () => void;
  nodes: EndpointNode[];
  onRefreshNodes: () => void;
  isTerminalOpen: boolean;
  onToggleTerminal: () => void;
  onOpenHardwareModal: () => void;
  localTokens: number;
  frontierTokens: number;
  uiScale: number;
  onUpdateUiScale: (scale: number) => void;
}

export const Header: React.FC<HeaderProps> = ({
  workspacePath,
  recentWorkspaces = [],
  onSelectFolder,
  onOpenRecent,
  onNewProject,
  nodes,
  onRefreshNodes,
  isTerminalOpen,
  onToggleTerminal,
  onOpenHardwareModal,
  localTokens,
  frontierTokens,
  uiScale,
  onUpdateUiScale
}) => {
  const [showScalePopover, setShowScalePopover] = useState(false);
  const [projectsOpen, setProjectsOpen] = useState(false);
  const popoverRef = useRef<HTMLDivElement>(null);
  const projectsRef = useRef<HTMLDivElement>(null);

  // Close popover when clicking outside
  useEffect(() => {
    if (!showScalePopover) return;
    const handleClickOutside = (e: MouseEvent) => {
      if (popoverRef.current && !popoverRef.current.contains(e.target as Node)) {
        setShowScalePopover(false);
      }
    };
    window.addEventListener('mousedown', handleClickOutside);
    return () => window.removeEventListener('mousedown', handleClickOutside);
  }, [showScalePopover]);

  useEffect(() => {
    if (!projectsOpen) return;
    const handleClickOutside = (e: MouseEvent) => {
      if (projectsRef.current && !projectsRef.current.contains(e.target as Node)) {
        setProjectsOpen(false);
      }
    };
    window.addEventListener('mousedown', handleClickOutside);
    return () => window.removeEventListener('mousedown', handleClickOutside);
  }, [projectsOpen]);

  const scalePercent = Math.round(uiScale * 100);

  return (
    <header className="min-h-12 h-auto bg-[#121214] border-b border-[#27272a] px-3 py-1.5 flex flex-nowrap items-center gap-3 select-none shrink-0 relative z-30">
      {/* Brand & Workspace — stay on this row; long names wrap inside the button */}
      <div className="flex flex-nowrap items-center gap-3 shrink-0">
        <div className="flex items-center space-x-2 text-indigo-400 font-bold tracking-tight text-sm shrink-0">
          <Layers className="w-5 h-5" />
          <span>LocalAgents Studio</span>
        </div>
        
        <div className="h-4 w-[1px] bg-[#27272a] shrink-0" />

        <button
          onClick={onNewProject}
          className="flex items-center space-x-1.5 text-xs text-zinc-300 hover:text-white bg-[#1e1e24] hover:bg-indigo-600/30 border border-[#2e2e38] hover:border-indigo-500/50 px-2.5 py-1 rounded transition shrink-0"
          title="New project: open a folder, clear editor tabs, start a fresh chat"
        >
          <FolderPlus className="w-3.5 h-3.5 text-indigo-400" />
          <span>New Project</span>
        </button>

        <div className="relative shrink-0" ref={projectsRef}>
          <button
            type="button"
            onClick={() => setProjectsOpen(o => !o)}
            className="flex items-center gap-1.5 text-xs text-zinc-200 hover:text-white bg-[#1e1e24] hover:bg-[#27272a] border border-[#2e2e38] px-2.5 py-1 rounded transition max-w-[11rem]"
            title={workspacePath || 'Open a project'}
          >
            <Folder className="w-3.5 h-3.5 text-amber-400 shrink-0" />
            <span className="font-medium text-left leading-tight whitespace-normal break-words">{workspacePath ? workspaceLabel(workspacePath) : 'No folder'}</span>
            <ChevronDown className="w-3 h-3 text-zinc-500 shrink-0" />
          </button>
          {projectsOpen && (
            <div className="absolute left-0 top-full mt-1 z-50 w-80 max-h-80 overflow-y-auto bg-[#1a1a20] border border-[#2e2e3a] rounded-lg shadow-xl py-1">
              <div className="px-2.5 py-1.5 text-[10px] uppercase tracking-wide text-zinc-500 font-semibold">
                Projects
              </div>
              {workspacePath && (
                <div className="px-2.5 py-1.5 text-[11px] text-indigo-200 truncate" title={workspacePath}>
                  {workspaceLabel(workspacePath)}
                  <div className="text-[10px] text-zinc-500 truncate font-mono">{workspacePath}</div>
                </div>
              )}
              {recentWorkspaces
                .filter(p => normalizeWorkspacePath(p) !== normalizeWorkspacePath(workspacePath || ''))
                .map(p => (
                  <button
                    key={p}
                    type="button"
                    onClick={() => {
                      setProjectsOpen(false);
                      onOpenRecent(p);
                    }}
                    className="w-full text-left px-2.5 py-1.5 hover:bg-[#252530] text-xs text-zinc-200"
                    title={p}
                  >
                    <div className="truncate">{workspaceLabel(p)}</div>
                    <div className="text-[10px] text-zinc-500 truncate font-mono">{p}</div>
                  </button>
                ))}
              <div className="my-1 border-t border-[#2e2e3a]" />
              <button
                type="button"
                onClick={() => {
                  setProjectsOpen(false);
                  onSelectFolder();
                }}
                className="w-full text-left px-2.5 py-1.5 hover:bg-[#252530] text-xs text-zinc-200 flex items-center gap-2"
              >
                <FolderOpen className="w-3.5 h-3.5 text-amber-400" />
                Open folder
              </button>
              <button
                type="button"
                onClick={() => {
                  setProjectsOpen(false);
                  onNewProject();
                }}
                className="w-full text-left px-2.5 py-1.5 hover:bg-[#252530] text-xs text-zinc-200 flex items-center gap-2"
              >
                <FolderPlus className="w-3.5 h-3.5 text-indigo-400" />
                New project
              </button>
            </div>
          )}
        </div>
      </div>

      {/* Cluster, tokens, and buttons stay on this row. Text inside a control wraps, and that control grows taller. */}
      <div className="flex flex-nowrap items-center gap-2 flex-1 min-w-0 justify-end">
        {/* Token Savings Pill */}
        <div 
          onClick={onOpenHardwareModal}
          className="flex flex-wrap items-center gap-x-2 gap-y-0.5 bg-[#18181d] border border-[#272732] px-2.5 py-1 rounded-xl text-[11px] cursor-pointer hover:border-zinc-600 transition min-w-0 flex-1 max-w-max"
          title="Click to view token statistics & savings"
        >
          <div className="flex items-center space-x-1 text-emerald-400 font-mono shrink-0">
            <Zap className="w-3 h-3" />
            <span>Local: {localTokens.toLocaleString()} tok</span>
          </div>
          <span className="text-zinc-600 shrink-0">•</span>
          <div className="flex items-center space-x-1 text-sky-400 font-mono shrink-0">
            <Cloud className="w-3 h-3" />
            <span>Frontier: {frontierTokens.toLocaleString()} tok</span>
          </div>
        </div>

        {/* Cluster Status Bar */}
        <div 
          onClick={onOpenHardwareModal}
          className="flex flex-wrap items-center gap-x-2 gap-y-1 bg-[#18181b] border border-[#27272a] hover:border-zinc-700 px-2.5 py-1 rounded cursor-pointer transition min-w-0 flex-1 max-w-max"
          title="Click to configure hardware, model recommendations & benchmarks"
        >
          <Cpu className="w-3.5 h-3.5 text-zinc-400 shrink-0" />
          <span className="text-[11px] text-zinc-400 font-medium shrink-0">Cluster:</span>
          
          <div className="contents">
            {nodes.length === 0 ? (
              <span className="text-[10px] text-amber-400 font-medium flex items-center space-x-1">
                <span className="w-1.5 h-1.5 rounded-full bg-amber-400 animate-pulse" />
                <span>No endpoints (Click to configure)</span>
              </span>
            ) : (
              nodes.map(node => (
                <div key={node.id} className="flex items-center space-x-1 text-[11px] shrink-0">
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
              ))
            )}
          </div>
        </div>

        <button
          onClick={onRefreshNodes}
          className="p-1.5 text-zinc-400 hover:text-white hover:bg-[#27272a] rounded transition shrink-0"
          title="Refresh cluster nodes status"
        >
          <RefreshCw className="w-3.5 h-3.5" />
        </button>

        {/* Discord-style UI & Text Scaling Control */}
        <div className="relative shrink-0" ref={popoverRef}>
          <button
            onClick={() => setShowScalePopover(prev => !prev)}
            className={`flex items-center space-x-1.5 px-2 py-1 text-xs rounded border transition ${
              scalePercent !== 100 || showScalePopover
                ? 'bg-indigo-600/20 border-indigo-500 text-indigo-300 font-medium'
                : 'bg-[#18181b] border-[#27272a] text-zinc-400 hover:text-white'
            }`}
            title="UI & Text Scaling slider (Discord-style) • Ctrl +/- to zoom"
          >
            <Sliders className="w-3.5 h-3.5 text-indigo-400" />
            <span className="font-mono text-[11px]">{scalePercent}%</span>
          </button>

          {showScalePopover && (
            <div className="absolute right-0 top-full mt-2 w-72 bg-[#161619] border border-[#2e2e38] rounded-xl shadow-2xl p-3.5 flex flex-col space-y-3 z-50 text-zinc-200">
              <div className="flex items-center justify-between">
                <span className="text-xs font-bold text-zinc-100 flex items-center space-x-1.5">
                  <Sliders className="w-3.5 h-3.5 text-indigo-400" />
                  <span>UI & Text Scaling</span>
                </span>
                <span className="text-xs font-mono font-bold text-indigo-400 bg-indigo-950/60 px-2 py-0.5 rounded border border-indigo-500/30">
                  {scalePercent}%
                </span>
              </div>

              <p className="text-[11px] text-zinc-400 leading-tight">
                Scales text, chat containers, and editor for high-res (1440p / 4K) displays.
              </p>

              {/* Smooth slider */}
              <div className="flex flex-col space-y-1">
                <input
                  type="range"
                  min="0.75"
                  max="1.75"
                  step="0.05"
                  value={uiScale}
                  onChange={(e) => onUpdateUiScale(parseFloat(e.target.value))}
                  className="w-full accent-indigo-500 cursor-pointer h-1.5 bg-[#25252e] rounded-lg"
                />
                <div className="flex justify-between text-[9px] text-zinc-500 font-mono">
                  <span>75%</span>
                  <span>100%</span>
                  <span>125%</span>
                  <span>150%</span>
                  <span>175%</span>
                </div>
              </div>

              {/* Quick Presets */}
              <div className="grid grid-cols-4 gap-1 pt-1 text-[10px]">
                {[0.8, 1.0, 1.25, 1.5].map(val => (
                  <button
                    key={val}
                    type="button"
                    onClick={() => onUpdateUiScale(val)}
                    className={`py-1 rounded font-mono transition border ${
                      Math.abs(uiScale - val) < 0.02
                        ? 'bg-indigo-600 text-white border-indigo-500 font-bold'
                        : 'bg-[#1e1e24] text-zinc-400 hover:text-white border-[#2c2c36] hover:bg-[#25252e]'
                    }`}
                  >
                    {Math.round(val * 100)}%
                  </button>
                ))}
              </div>

              <div className="flex items-center justify-between pt-2 border-t border-[#272730] text-[10px] text-zinc-500">
                <span>Shortcuts: <kbd className="px-1 py-0.5 bg-[#22222a] rounded font-mono text-zinc-400">Ctrl +/-</kbd></span>
                {scalePercent !== 100 && (
                  <button
                    type="button"
                    onClick={() => onUpdateUiScale(1.0)}
                    className="flex items-center space-x-1 text-indigo-400 hover:text-indigo-300 transition"
                  >
                    <RotateCcw className="w-2.5 h-2.5" />
                    <span>Reset (100%)</span>
                  </button>
                )}
              </div>
            </div>
          )}
        </div>

        <button
          onClick={onToggleTerminal}
          className={`flex items-center space-x-1.5 px-2.5 py-1 text-xs rounded border transition shrink-0 ${
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
