import React from 'react';
import { AlertTriangle, Brain, Download, Gauge, RefreshCw, Trash2, Zap } from 'lucide-react';
import { EndpointNode } from '../../types';
import { modelSupportsThinking, thinkingToggleLabel } from '../../lib/thinking';
import { HelpTip } from '../agent/HelpTip';
import {
  DEFAULT_MODEL_NUM_CTX,
  clampNumCtx,
  ctxSizeOptions,
  estimateContextFit,
  formatCtxLabel,
  resolveModelMaxContext,
  resolveModelNumCtx,
  snapNumCtxToOption
} from '../../lib/contextSize';
import {
  estimateInstalledModelFit,
  fitSpillsToSystemRam,
  formatGB
} from '../../lib/recommender';

interface InstalledModelsPanelProps {
  currentNode: EndpointNode;
  benchmarkingModel: string | null;
  benchmarkingNodeId: string | null;
  customPullTag: string;
  onCustomPullTagChange: (v: string) => void;
  isPullingCustom: boolean;
  customPullStatus: string | null;
  customPullPercent: number | null;
  onDirectPull: (e: React.FormEvent) => void;
  onToggleModelEnabled: (node: EndpointNode, modelName: string) => void;
  onSetAllModelsEnabled?: (node: EndpointNode, enabled: boolean) => void;
  onSetPrimaryModel: (node: EndpointNode, modelName: string) => void;
  onRunBenchmark: (node: EndpointNode, modelName: string) => void;
  onDeleteModel: (node: EndpointNode, modelName: string) => void;
  onToggleThinking?: (node: EndpointNode, modelName: string, enabled: boolean) => void;
  onSetModelNumCtx?: (node: EndpointNode, modelName: string, numCtx: number) => void;
  onInspectModel?: (node: EndpointNode, modelName: string) => void;
  inspectingModel?: string | null;
}

function isEmbeddingModel(m: { name: string; capabilities?: string[] }) {
  return (
    m.capabilities?.includes('embedding') ||
    m.name.toLowerCase().includes('embed') ||
    m.name.toLowerCase().includes('bge')
  );
}

export const InstalledModelsPanel: React.FC<InstalledModelsPanelProps> = ({
  currentNode,
  benchmarkingModel,
  benchmarkingNodeId,
  customPullTag,
  onCustomPullTagChange,
  isPullingCustom,
  customPullStatus,
  customPullPercent,
  onDirectPull,
  onToggleModelEnabled,
  onSetAllModelsEnabled,
  onSetPrimaryModel,
  onRunBenchmark,
  onDeleteModel,
  onToggleThinking,
  onSetModelNumCtx,
  onInspectModel,
  inspectingModel
}) => {
  const generativeModels = currentNode.models.filter(m => !isEmbeddingModel(m));
  const disabledSet = new Set(currentNode.disabledModels || []);
  const enabledCount = generativeModels.filter(m => !disabledSet.has(m.name)).length;

  return (
  <div className="bg-[#121215] border border-[#272730] rounded-xl p-4 space-y-3">
    <div className="flex items-center justify-between gap-2 flex-wrap">
      <div className="flex items-center space-x-2 text-xs font-bold text-zinc-200 min-w-0">
        <Gauge className="w-4 h-4 text-amber-400 shrink-0" />
        <span>Installed Models & Live Token/Sec Benchmarks</span>
      </div>
      <span className="text-[10px] text-zinc-500 shrink-0">
        {currentNode.models.length} model(s) available on this host
      </span>
    </div>

    {generativeModels.length > 0 && onSetAllModelsEnabled && (
      <div className="flex items-center justify-between gap-2 flex-wrap rounded-lg bg-[#18181d] border border-[#282834] px-2.5 py-1.5">
        <span className="text-[10px] text-zinc-500">
          Enable/disable for <span className="text-zinc-300 font-medium">{currentNode.name}</span> only
          <span className="text-zinc-600"> · </span>
          {enabledCount}/{generativeModels.length} on
        </span>
        <div className="flex items-center space-x-1.5 shrink-0">
          <button
            type="button"
            onClick={() => onSetAllModelsEnabled(currentNode, true)}
            className="px-2 py-0.5 text-[10px] rounded border border-[#30303c] bg-[#22222a] text-zinc-300 hover:text-emerald-200 hover:border-emerald-500/40 transition"
            title={`Select all generative models on ${currentNode.name}`}
          >
            Select all
          </button>
          <button
            type="button"
            onClick={() => onSetAllModelsEnabled(currentNode, false)}
            className="px-2 py-0.5 text-[10px] rounded border border-[#30303c] bg-[#22222a] text-zinc-300 hover:text-zinc-100 hover:border-zinc-500/50 transition"
            title={`Deselect all generative models on ${currentNode.name}`}
          >
            Deselect all
          </button>
        </div>
      </div>
    )}

    {currentNode.models.length === 0 ? (
      <div className="text-xs text-zinc-500 italic p-3 text-center bg-[#18181d] rounded-lg">
        No models discovered. Verify that Ollama is running and has downloaded models.
      </div>
    ) : (
      <div className="space-y-2">
        {currentNode.models.map(m => {
          const isEmbed = isEmbeddingModel(m);
          const isDisabled = (currentNode.disabledModels || []).includes(m.name);
          const isPrimary = !isEmbed && !isDisabled && (
            currentNode.activeModel === m.name ||
            (!currentNode.activeModel && currentNode.models.find(x => !(currentNode.disabledModels || []).includes(x.name))?.name === m.name)
          );
          const bm = currentNode.benchmarks?.[m.name];
          const isBenchmarkingThis = benchmarkingModel === m.name && benchmarkingNodeId === currentNode.id;
          const supportsThink = !isEmbed && modelSupportsThinking(m);
          const thinkPref = currentNode.modelPrefs?.[m.name]?.think;
          const thinkOn = thinkPref === true || thinkPref === 'true' ||
            (typeof thinkPref === 'string' && thinkPref !== 'false' && thinkPref.length > 0);
          // Default UX: OFF until user enables (faster for IDE)
          const thinkEnabled = thinkPref === undefined || thinkPref === null ? false : !!thinkOn;

          return (
            <div
              key={m.name}
              className={`bg-[#18181d] border rounded-lg p-2.5 space-y-2 text-xs transition ${
                isDisabled
                  ? 'border-[#22222a] opacity-50'
                  : isPrimary
                  ? 'border-indigo-500/50 bg-indigo-950/10'
                  : 'border-[#282834]'
              }`}
            >
              <div className="flex items-start justify-between gap-2">
                <div className="flex items-start space-x-2.5 min-w-0 flex-1">
                  {!isEmbed && (
                    <button
                      type="button"
                      onClick={() => onToggleModelEnabled(currentNode, m.name)}
                      title={isDisabled ? 'Model is OFF (click to enable for IDE)' : 'Model is ON (click to disable)'}
                      className={`relative inline-flex h-4 w-8 shrink-0 mt-0.5 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out ${
                        !isDisabled ? 'bg-emerald-500' : 'bg-zinc-700'
                      }`}
                    >
                      <span
                        className={`pointer-events-none inline-block h-3 w-3 transform rounded-full bg-white shadow ring-0 transition duration-200 ease-in-out ${
                          !isDisabled ? 'translate-x-4' : 'translate-x-0'
                        }`}
                      />
                    </button>
                  )}

                  <div className="min-w-0 flex-1 space-y-1">
                    <span
                      className={`block font-mono font-semibold text-[12px] leading-snug break-words line-clamp-2 ${
                        isDisabled ? 'text-zinc-500 line-through' : 'text-zinc-100'
                      }`}
                      title={m.name}
                    >
                      {m.name}
                    </span>

                    <div className="flex items-center flex-wrap gap-1.5">
                      {isDisabled && (
                        <span className="text-[9px] bg-zinc-800 text-zinc-400 px-1.5 py-0.5 rounded font-sans shrink-0">
                          Disabled
                        </span>
                      )}

                      {!isEmbed && !isDisabled && (
                        isPrimary ? (
                          <span className="text-[9px] bg-indigo-500/20 text-indigo-300 border border-indigo-500/40 px-1.5 py-0.5 rounded font-sans font-semibold shrink-0">
                            ★ Active Node Model
                          </span>
                        ) : (
                          <button
                            type="button"
                            onClick={() => onSetPrimaryModel(currentNode, m.name)}
                            className="text-[9px] bg-[#22222c] hover:bg-indigo-600/30 text-zinc-400 hover:text-indigo-200 border border-[#30303e] px-1.5 py-0.5 rounded font-sans transition shrink-0"
                            title="Use this model whenever the Conductor assigns tasks to this hardware node"
                          >
                            Set as Node Default
                          </button>
                        )
                      )}

                      {isEmbed && (
                        <span className="text-[9px] bg-purple-500/20 text-purple-300 border border-purple-500/30 px-1.5 py-0.5 rounded font-mono shrink-0">
                          Vector Embedding (RAG)
                        </span>
                      )}
                      {m.size > 0 && (
                        <span className="text-[10px] text-zinc-500 font-mono shrink-0">
                          ({(m.size / 1e9).toFixed(1)} GB)
                        </span>
                      )}
                    </div>
                  </div>
                </div>

                <div className="flex items-center space-x-1.5 shrink-0">
                  {bm ? (
                    bm.isEmbedding ? (
                      <div className="flex items-center space-x-1 bg-purple-500/10 border border-purple-500/30 px-1.5 py-0.5 rounded text-[10px] font-mono text-purple-300">
                        <Zap className="w-3 h-3 text-purple-400" />
                        <span>{bm.totalMs}ms</span>
                      </div>
                    ) : (
                      <div className={`flex items-center space-x-1 px-1.5 py-0.5 rounded text-[10px] font-mono ${
                        bm.provisional
                          ? 'bg-zinc-700/40 border border-zinc-600 text-zinc-300'
                          : 'bg-amber-500/10 border border-amber-500/30 text-amber-300'
                      }`}>
                        <Zap className={`w-3 h-3 ${bm.provisional ? 'text-zinc-400' : 'text-amber-400'}`} />
                        <span>{bm.evalTokPerSec} t/s{bm.provisional ? '*' : ''}</span>
                      </div>
                    )
                  ) : (
                    <span className="text-[9px] text-zinc-600 font-mono hidden sm:inline">
                      —
                    </span>
                  )}

                  <button
                    onClick={() => onRunBenchmark(currentNode, m.name)}
                    disabled={benchmarkingModel !== null}
                    className="flex items-center space-x-1 px-1.5 py-1 bg-[#22222a] hover:bg-indigo-600 hover:text-white text-zinc-300 border border-[#30303c] rounded text-[10px] transition disabled:opacity-50"
                    title={isEmbed ? 'Test embedding latency' : 'Benchmark tokens/sec'}
                  >
                    {isBenchmarkingThis ? (
                      <RefreshCw className="w-3 h-3 animate-spin text-amber-400" />
                    ) : (
                      <Zap className="w-3 h-3 text-amber-400" />
                    )}
                    <span className="hidden md:inline">{isBenchmarkingThis ? '…' : 'Bench'}</span>
                  </button>

                  <button
                    onClick={() => onDeleteModel(currentNode, m.name)}
                    className="p-1 text-zinc-500 hover:text-red-400 hover:bg-[#282834] rounded transition"
                    title={`Delete ${m.name} from ${currentNode.name}`}
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                </div>
              </div>

              {/* Context window (num_ctx) — per-model on this node */}
              {!isEmbed && onSetModelNumCtx && currentNode.type !== 'openai' && (() => {
                const maxCtx = resolveModelMaxContext(m.name, m);
                const storedCtx = resolveModelNumCtx(currentNode, m.name, DEFAULT_MODEL_NUM_CTX);
                const currentCtx = snapNumCtxToOption(storedCtx, maxCtx);
                const options = ctxSizeOptions(maxCtx, currentCtx);
                const fit = estimateContextFit(currentCtx);
                const vramFit = estimateInstalledModelFit(m, currentNode.hardware, currentCtx);
                const spills = fitSpillsToSystemRam(vramFit.kind);
                const overMax = maxCtx != null && currentCtx > maxCtx;
                const spillTitle =
                  vramFit.kind === 'none'
                    ? "Won't fit in VRAM + system RAM at this context size"
                    : 'May spill into system RAM (slower)';
                return (
                  <div className="pt-1.5 border-t border-[#252530] space-y-1.5">
                    <div className="flex items-center justify-between gap-2 flex-wrap">
                      <div className="flex items-center space-x-1.5 text-[11px] text-indigo-300 font-medium min-w-0">
                        <Gauge className="w-3.5 h-3.5 shrink-0" />
                        <span>Context size</span>
                        <HelpTip title="Context window (num_ctx)" align="left">
                          <p>
                            How many tokens Ollama keeps in the prompt window for this model on this node.
                            Larger context uses more VRAM.
                          </p>
                          <p>
                            VRAM totals are approximate: model weights + KV cache for this context size
                            (scaled by this node&apos;s KV cache type). Spill warnings use usable VRAM after
                            reserved VRAM.
                          </p>
                          <p>
                            Rough estimates for English text; code and images differ:
                          </p>
                          <ul className="list-disc pl-3.5 space-y-0.5">
                            <li>1 token ≈ 0.75 English words</li>
                            <li>1 page ≈ 500 words ≈ 667 tokens</li>
                            <li>1 short website ≈ 2,500 tokens</li>
                            <li>1 medium source file ≈ 1,500 tokens</li>
                          </ul>
                          {!maxCtx && (
                            <p className="text-amber-400/90">
                              Max context unknown for this model — oversized values waste VRAM and may fail to load.
                            </p>
                          )}
                        </HelpTip>
                        {maxCtx != null && (
                          <span className="text-[9px] text-zinc-500 font-normal">
                            max {formatCtxLabel(maxCtx)}
                          </span>
                        )}
                      </div>
                      <select
                        value={currentCtx}
                        onChange={(e) => {
                          onSetModelNumCtx(
                            currentNode,
                            m.name,
                            clampNumCtx(parseInt(e.target.value, 10), maxCtx)
                          );
                        }}
                        className="bg-[#1a1a20] border border-[#2a2a36] focus:border-indigo-500 text-zinc-200 rounded px-1.5 py-0.5 outline-none font-mono text-[11px] shrink-0"
                        title="Ollama options.num_ctx"
                      >
                        {options.map(sz => (
                          <option key={sz} value={sz}>
                            {formatCtxLabel(sz)}
                          </option>
                        ))}
                      </select>
                    </div>
                    <p className={`text-[10px] font-mono leading-snug ${overMax ? 'text-amber-400' : 'text-zinc-500'}`}>
                      {fit.label}
                      {overMax ? ' · exceeds model max' : ''}
                      {!maxCtx ? ' · max unknown — large ctx burns VRAM' : ''}
                    </p>
                    <p className="text-[10px] font-mono leading-snug text-zinc-400 flex items-center flex-wrap gap-x-1.5 gap-y-0.5">
                      <span>
                        Model ~{formatGB(vramFit.weightsGB)} · Context ~{formatGB(vramFit.kvGB)} · Total ~
                        {formatGB(vramFit.totalGB)}
                      </span>
                      {spills && (
                        <span title={spillTitle} className="inline-flex" aria-label={spillTitle}>
                          <AlertTriangle className="w-3.5 h-3.5 text-amber-400 shrink-0" />
                        </span>
                      )}
                    </p>
                  </div>
                );
              })()}

              {/* Thinking controls — only when Ollama advertises support */}
              {!isEmbed && supportsThink && onToggleThinking && (
                <div className="flex items-start justify-between gap-3 pt-1.5 border-t border-[#252530]">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center space-x-1.5 text-[11px] text-violet-300 font-medium">
                      <Brain className="w-3.5 h-3.5 shrink-0" />
                      <span>Thinking mode</span>
                      <span className="text-[9px] text-zinc-500 font-normal">
                        (from Ollama model info)
                      </span>
                    </div>
                    {m.description && (
                      <p className="text-[10px] text-zinc-500 mt-0.5 line-clamp-2" title={m.description}>
                        {m.description}
                      </p>
                    )}
                    <p className="text-[10px] text-zinc-500 mt-0.5">
                      When ON, the model reasons before answering (slower, often smarter). OFF replies faster — better for coding loops.
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={() => onToggleThinking(currentNode, m.name, !thinkEnabled)}
                    className={`flex items-center space-x-1.5 px-2.5 py-1 rounded border text-[11px] font-medium transition shrink-0 ${
                      thinkEnabled
                        ? 'bg-violet-600/30 border-violet-500/50 text-violet-200'
                        : 'bg-[#22222a] border-[#30303c] text-zinc-400 hover:text-zinc-200'
                    }`}
                    title={thinkEnabled ? 'Click to disable thinking (faster)' : 'Click to enable thinking (slower, deeper)'}
                  >
                    <Brain className={`w-3.5 h-3.5 ${thinkEnabled ? 'text-violet-300' : 'text-zinc-500'}`} />
                    <span>{thinkingToggleLabel(thinkEnabled)}</span>
                  </button>
                </div>
              )}

              {/* Not yet inspected — offer to read Ollama description */}
              {!isEmbed && !supportsThink && !m.thinking && onInspectModel && (
                <div className="flex items-center justify-between gap-2 pt-1.5 border-t border-[#252530]">
                  <span className="text-[10px] text-zinc-500">
                    Check Ollama for thinking support / description
                  </span>
                  <button
                    type="button"
                    onClick={() => onInspectModel(currentNode, m.name)}
                    disabled={inspectingModel === m.name}
                    className="flex items-center space-x-1 px-2 py-1 text-[10px] text-zinc-400 hover:text-white border border-[#30303c] rounded transition disabled:opacity-50"
                  >
                    {inspectingModel === m.name ? (
                      <RefreshCw className="w-3 h-3 animate-spin" />
                    ) : (
                      <Brain className="w-3 h-3" />
                    )}
                    <span>Inspect model</span>
                  </button>
                </div>
              )}
            </div>
          );
        })}
      </div>
    )}

    {currentNode.type !== 'openai' && (
      <form onSubmit={onDirectPull} className="pt-3 border-t border-[#252530] flex flex-col space-y-2">
        <label htmlFor="ollama-direct-pull" className="text-[11px] text-zinc-400 font-medium flex items-center space-x-1.5">
          <Download className="w-3.5 h-3.5 text-indigo-400" />
          <span>Pull any model from Ollama library directly to {currentNode.name}:</span>
        </label>
        <div className="flex items-center space-x-2">
          <input
            id="ollama-direct-pull"
            type="text"
            name="ollamaModelTag"
            autoComplete="off"
            spellCheck={false}
            placeholder="e.g. qwen2.5-coder:14b, deepseek-r1:8b, starcoder2:7b..."
            value={customPullTag}
            onChange={(e) => onCustomPullTagChange(e.target.value)}
            onMouseDown={(e) => {
              e.stopPropagation();
              const el = e.currentTarget;
              requestAnimationFrame(() => el.focus());
            }}
            onKeyDown={(e) => e.stopPropagation()}
            className="min-w-0 flex-1 select-text bg-[#18181d] border border-[#2c2c38] focus:border-indigo-500 text-zinc-200 rounded px-3 py-1.5 outline-none font-mono text-xs"
          />
          <button
            type="submit"
            disabled={isPullingCustom || !customPullTag.trim()}
            className="px-3.5 py-1.5 bg-indigo-600 hover:bg-indigo-500 disabled:opacity-40 text-white rounded text-xs font-medium flex items-center space-x-1.5 transition shrink-0 shadow-sm"
          >
            {isPullingCustom ? <RefreshCw className="w-3.5 h-3.5 animate-spin" /> : <Download className="w-3.5 h-3.5" />}
            <span>{isPullingCustom ? 'Pulling...' : `Pull to ${currentNode.name.split(' ')[0]}`}</span>
          </button>
        </div>
        {customPullStatus && (
          <div className="bg-[#181820] border border-indigo-500/30 p-2.5 rounded-lg text-[11px] space-y-1.5 font-mono">
            <div className="flex justify-between text-indigo-300">
              <span>{customPullStatus}</span>
              {customPullPercent !== null && <span>{customPullPercent}%</span>}
            </div>
            {customPullPercent !== null && (
              <div className="w-full bg-[#101014] h-1.5 rounded-full overflow-hidden">
                <div className="bg-indigo-500 h-full transition-all duration-300" style={{ width: `${customPullPercent}%` }} />
              </div>
            )}
          </div>
        )}
      </form>
    )}
  </div>
  );
};
