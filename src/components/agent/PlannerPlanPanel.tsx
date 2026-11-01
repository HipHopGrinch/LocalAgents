import React from 'react';
import { ListChecks } from 'lucide-react';
import { PlannerPlan } from '../../types';

export interface PlannerPlanPanelProps {
  plan: PlannerPlan;
}

/** Durable plan panel — steps + task status (fills tall orchestration column). */
export const PlannerPlanPanel: React.FC<PlannerPlanPanelProps> = ({ plan }) => {
  if (!plan.steps.length) return null;
  return (
    <div className="flex flex-col min-h-0 flex-1 rounded-md border border-[#2a2a36] bg-[#121215] px-2.5 py-2">
      <div className="flex items-center gap-1.5 text-[10px] uppercase font-bold tracking-wider text-sky-300/90 shrink-0">
        <ListChecks className="w-3 h-3" />
        <span>Planner plan · {plan.status}</span>
      </div>
      <p className="text-[11px] text-zinc-300 mt-1 leading-snug shrink-0">{plan.summary}</p>
      <ol className="mt-2 space-y-1.5 list-none overflow-y-auto min-h-0 flex-1 pr-0.5">
        {plan.steps.map(step => {
          const active = plan.activeStepId === step.id;
          const statusClass =
            step.status === 'completed'
              ? 'text-emerald-400'
              : step.status === 'failed'
                ? 'text-rose-400'
                : step.status === 'in_progress' || active
                  ? 'text-amber-300'
                  : 'text-zinc-500';
          const reviewClass =
            step.status === 'failed' ? 'text-rose-300/90' : 'text-sky-300/90';
          return (
            <li
              key={step.id}
              className={`rounded border px-2 py-1.5 ${
                active
                  ? 'border-amber-500/40 bg-amber-500/5'
                  : 'border-[#2a2a36] bg-[#0e0e12]'
              }`}
            >
              <div className="flex items-center gap-1.5 flex-wrap text-[11px]">
                <span className={`font-mono text-[9px] uppercase ${statusClass}`}>
                  {step.status.replace('_', ' ')}
                </span>
                <span className="font-semibold text-zinc-100">
                  Step {step.id}: {step.title}
                </span>
              </div>
              <ul className="mt-1 space-y-0.5">
                {step.tasks.map(t => {
                  const mark =
                    t.status === 'completed' ? '✓' : t.status === 'failed' ? '!' : t.status === 'in_progress' ? '›' : '·';
                  return (
                    <li key={t.id} className="text-[10px] text-zinc-400 font-mono truncate">
                      {mark} #{t.id} {t.title}
                      {t.file ? ` — ${t.file}` : ''}
                    </li>
                  );
                })}
              </ul>
              {step.reviewNote && (
                <p className={`text-[10px] ${reviewClass} mt-1 leading-snug`}>
                  Review: {step.reviewNote}
                </p>
              )}
            </li>
          );
        })}
      </ol>
    </div>
  );
};
