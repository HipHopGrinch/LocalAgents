import React from 'react';
import { CheckCircle2, Download } from 'lucide-react';
import { EndpointNode } from '../../types';
import { MODEL_CATALOG, TASKS, TaskId } from '../../config/modelCatalog';
import { estimateFit, FIT_LABEL, isInstalled } from '../../lib/recommender';

interface ModelHubPanelProps {
  nodes: EndpointNode[];
  currentNode: EndpointNode;
  selectedNodeId: string;
  onSelectNodeId: (id: string) => void;
  selectedTask: TaskId;
  onSelectTask: (task: TaskId) => void;
  estimateContext: number;
  onUpdateEstimateContext: (ctx: number) => void;
  pullProgress: Record<string, { status: string; completed?: number; total?: number }>;
  onPullModel: (node: EndpointNode, tag: string) => void;
}

export const ModelHubPanel: React.FC<ModelHubPanelProps> = ({
  nodes,
  currentNode,
  selectedNodeId,
  onSelectNodeId,
  selectedTask,
  onSelectTask,
  estimateContext,
  onUpdateEstimateContext,
  pullProgress,
  onPullModel
}) => (
  <div className="flex-1 flex flex-col p-5 overflow-y-auto space-y-4">
    <div className="flex items-center justify-between bg-[#121215] border border-[#272730] p-3 rounded-xl text-xs">
      <div className="flex items-center space-x-3">
        <span className="font-semibold text-zinc-200">Evaluating for Node:</span>
        <select
          value={selectedNodeId}
          onChange={(e) => onSelectNodeId(e.target.value)}
          className="bg-[#1c1c24] border border-[#2c2c38] text-zinc-100 rounded px-2.5 py-1 outline-none text-xs"
        >
          {nodes.filter(n => n.type !== 'openai').map(n => (
            <option key={n.id} value={n.id}>
              {n.name} ({n.hardware.gpu} · {n.hardware.vramGB}GB VRAM)
            </option>
          ))}
        </select>
      </div>

      <div className="flex items-center space-x-2">
        <span className="text-zinc-400 text-[11px]">Context length for fit test:</span>
        <select
          value={estimateContext}
          onChange={(e) => onUpdateEstimateContext(parseInt(e.target.value, 10))}
          className="bg-[#1c1c24] border border-[#2c2c38] text-zinc-100 rounded px-2 py-1 outline-none text-xs font-mono"
        >
          <option value={8192}>8K</option>
          <option value={16384}>16K (Recommended)</option>
          <option value={32768}>32K</option>
          <option value={65536}>64K</option>
        </select>
      </div>
    </div>

    <div className="flex items-center space-x-1.5 overflow-x-auto pb-1 text-xs">
      {TASKS.map(t => (
        <button
          key={t.id}
          onClick={() => onSelectTask(t.id)}
          className={`px-3 py-1.5 rounded-lg border transition shrink-0 ${
            selectedTask === t.id
              ? 'bg-indigo-600 text-white border-indigo-500 font-medium'
              : 'bg-[#18181d] border-[#272732] text-zinc-400 hover:text-zinc-200'
          }`}
        >
          {t.label}
        </button>
      ))}
    </div>

    <div className="grid grid-cols-2 gap-3">
      {MODEL_CATALOG.filter(m => m.quality[selectedTask]).map(model => {
        const fit = estimateFit(model, currentNode.hardware, estimateContext);
        const installed = isInstalled(currentNode, model.tag);
        const pullKey = `${currentNode.id}:${model.tag}`;
        const pulling = pullProgress[pullKey];

        return (
          <div
            key={model.tag}
            className="bg-[#121215] border border-[#272730] rounded-xl p-3.5 flex flex-col justify-between space-y-2.5 text-xs"
          >
            <div>
              <div className="flex items-center justify-between">
                <span className="font-mono font-bold text-zinc-100">{model.tag}</span>
                <span
                  className={`px-2 py-0.5 rounded text-[10px] font-medium border ${
                    fit.kind === 'gpu'
                      ? 'bg-emerald-500/10 text-emerald-300 border-emerald-500/30'
                      : fit.kind === 'partial'
                      ? 'bg-amber-500/10 text-amber-300 border-amber-500/30'
                      : 'bg-red-500/10 text-red-300 border-red-500/30'
                  }`}
                >
                  {FIT_LABEL[fit.kind]}
                </span>
              </div>
              <p className="text-[11px] text-zinc-400 mt-1 leading-relaxed">{model.notes}</p>
            </div>

            <div className="pt-2 border-t border-[#22222a] flex items-center justify-between text-[11px]">
              <div className="flex items-center space-x-2 text-zinc-400 font-mono text-[10px]">
                <span>Size: {model.sizeGB.toFixed(1)} GB</span>
                <span>•</span>
                <span>~{fit.tokensPerSec} tok/s</span>
              </div>

              {installed ? (
                <span className="flex items-center space-x-1 text-emerald-400 text-[11px] font-medium">
                  <CheckCircle2 className="w-3.5 h-3.5" />
                  <span>Installed</span>
                </span>
              ) : pulling ? (
                <span className="text-[10px] text-amber-300 animate-pulse font-mono">
                  {pulling.status}
                </span>
              ) : (
                <button
                  onClick={() => onPullModel(currentNode, model.tag)}
                  className="flex items-center space-x-1 px-2.5 py-1 bg-indigo-600 hover:bg-indigo-500 text-white rounded text-[11px] font-medium transition"
                >
                  <Download className="w-3 h-3" />
                  <span>Pull Model</span>
                </button>
              )}
            </div>
          </div>
        );
      })}
    </div>
  </div>
);
