import React from 'react';
import { CheckCircle2, ListChecks } from 'lucide-react';
import { PlanOption } from '../../types';

export interface PlanOptionsCardProps {
  options: PlanOption[];
  selectedId?: string;
  disabled?: boolean;
  onSelect: (option: PlanOption) => void;
}

/** Clickable Planner options — styled like ToolActionCard buttons. */
export const PlanOptionsCard: React.FC<PlanOptionsCardProps> = ({
  options,
  selectedId,
  disabled,
  onSelect
}) => {
  if (!options.length) return null;

  return (
    <div className="mt-3 space-y-2 pt-2 border-t border-[#31313e]">
      <div className="flex items-center space-x-1.5 text-[10px] uppercase font-bold text-amber-300/90 tracking-wider">
        <ListChecks className="w-3 h-3" />
        <span>Choose a plan</span>
      </div>
      <div className="space-y-1.5">
        {options.map(opt => {
          const selected = selectedId === opt.id;
          return (
            <button
              key={opt.id}
              type="button"
              disabled={disabled || !!selectedId}
              onClick={() => onSelect(opt)}
              className={`w-full text-left rounded-md p-2.5 border transition font-sans ${
                selected
                  ? 'bg-emerald-600/20 border-emerald-500/40 text-emerald-100'
                  : selectedId
                    ? 'bg-[#121215] border-[#2a2a36] text-zinc-500 opacity-60 cursor-default'
                    : 'bg-[#121215] border-[#2a2a36] text-zinc-200 hover:border-indigo-500/50 hover:bg-[#1a1a24]'
              }`}
            >
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <div className="text-[11px] font-semibold text-zinc-100 flex items-center gap-1.5">
                    <span className="font-mono text-indigo-300">Option {opt.id}</span>
                    <span className="truncate">{opt.title}</span>
                  </div>
                  <p className="text-[10px] text-zinc-400 mt-1 leading-relaxed">{opt.description}</p>
                </div>
                {selected ? (
                  <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0 mt-0.5" />
                ) : (
                  <span className="shrink-0 text-[9px] px-1.5 py-0.5 rounded bg-indigo-600/30 text-indigo-200 border border-indigo-500/30">
                    Pick
                  </span>
                )}
              </div>
            </button>
          );
        })}
      </div>
      <p className="text-[9px] text-zinc-500">
        Click an option, or type <span className="font-mono text-zinc-400">option 1</span>,{' '}
        <span className="font-mono text-zinc-400">2</span>, etc.
      </p>
    </div>
  );
};
