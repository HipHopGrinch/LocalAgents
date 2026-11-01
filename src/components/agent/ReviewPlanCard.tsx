import React from 'react';
import { CheckCircle2, ListTodo, Send, ThumbsUp } from 'lucide-react';
import { ReviewFixPlan } from '../../types';

export interface ReviewPlanCardProps {
  plan: ReviewFixPlan;
  sent?: boolean;
  disabled?: boolean;
  /** Hands review tasks to Planner (contracts), which then auto-continues to Coder */
  onSendToPlanner: () => void;
  /** Clean review (no tasks) — resume auto-continue when user approval is required */
  onContinue?: () => void;
}

/** Reviewer fix plan — Send to Planner, or Looks good when the plan is empty. */
export const ReviewPlanCard: React.FC<ReviewPlanCardProps> = ({
  plan,
  sent,
  disabled,
  onSendToPlanner,
  onContinue
}) => {
  const clean = plan.tasks.length === 0;

  if (clean) {
    return (
      <div className="mt-3 space-y-2 pt-2 border-t border-[#31313e]">
        <div className="flex items-center space-x-1.5 text-[10px] uppercase font-bold text-emerald-300/90 tracking-wider">
          <ThumbsUp className="w-3 h-3" />
          <span>Review clean</span>
        </div>
        <p className="text-[11px] text-zinc-300 leading-relaxed">
          {plan.summary || 'No blocking issues found.'}
        </p>
        {onContinue && (
          <button
            type="button"
            disabled={disabled || sent}
            onClick={onContinue}
            className={`w-full flex items-center justify-center gap-2 rounded-md px-3 py-2 text-[12px] font-sans font-medium border transition ${
              sent
                ? 'bg-emerald-600/20 border-emerald-500/40 text-emerald-200 cursor-default'
                : 'bg-emerald-600 hover:bg-emerald-500 border-emerald-500/50 text-white'
            }`}
          >
            {sent ? (
              <>
                <CheckCircle2 className="w-3.5 h-3.5" />
                <span>Continued</span>
              </>
            ) : (
              <>
                <ThumbsUp className="w-3.5 h-3.5" />
                <span>Looks good / Continue</span>
              </>
            )}
          </button>
        )}
        {!sent && onContinue && (
          <p className="text-[9px] text-zinc-500">
            Approves this step and continues the auto-progress loop (next feature step or done).
          </p>
        )}
      </div>
    );
  }

  return (
    <div className="mt-3 space-y-2 pt-2 border-t border-[#31313e]">
      <div className="flex items-center space-x-1.5 text-[10px] uppercase font-bold text-violet-300/90 tracking-wider">
        <ListTodo className="w-3 h-3" />
        <span>Fix plan for Planner → Coder</span>
      </div>
      {plan.summary && (
        <p className="text-[11px] text-zinc-300 leading-relaxed">{plan.summary}</p>
      )}
      <ol className="space-y-1.5 list-none">
        {plan.tasks.map(task => {
          const status = task.status;
          const statusClass =
            status === 'completed'
              ? 'text-emerald-400'
              : status === 'failed'
                ? 'text-rose-400'
                : status === 'in_progress'
                  ? 'text-amber-300'
                  : 'text-zinc-500';
          return (
            <li
              key={task.id}
              className="rounded-md p-2.5 border border-[#2a2a36] bg-[#121215] text-zinc-200"
            >
              <div className="text-[11px] font-semibold text-zinc-100 flex items-center gap-1.5 flex-wrap">
                <span className="font-mono text-violet-300">Task {task.id}</span>
                {status && (
                  <span className={`font-mono text-[9px] uppercase ${statusClass}`}>
                    {status.replace('_', ' ')}
                  </span>
                )}
                <span>{task.title}</span>
                {task.file && (
                  <span className="font-mono text-[10px] text-zinc-500 truncate">{task.file}</span>
                )}
              </div>
              <p className="text-[10px] text-zinc-400 mt-1 leading-relaxed">{task.description}</p>
              {task.failureNote && (
                <p className="text-[10px] text-rose-300/90 mt-1 leading-relaxed">
                  Fix note: {task.failureNote}
                </p>
              )}
            </li>
          );
        })}
      </ol>
      <button
        type="button"
        disabled={disabled || sent}
        onClick={onSendToPlanner}
        className={`w-full flex items-center justify-center gap-2 rounded-md px-3 py-2 text-[12px] font-sans font-medium border transition ${
          sent
            ? 'bg-emerald-600/20 border-emerald-500/40 text-emerald-200 cursor-default'
            : 'bg-violet-600 hover:bg-violet-500 border-violet-500/50 text-white'
        }`}
      >
        {sent ? (
          <>
            <CheckCircle2 className="w-3.5 h-3.5" />
            <span>Sent to Planner</span>
          </>
        ) : (
          <>
            <Send className="w-3.5 h-3.5" />
            <span>Send to Planner</span>
          </>
        )}
      </button>
      {!sent && (
        <p className="text-[9px] text-zinc-500">
          Planner takes the next open task (one at a time), writes a fix contract, then{' '}
          <span className="font-mono text-zinc-400">coder</span> implements it. Reviewer verifies that
          task and keeps the durable list — it does not apply edits.
        </p>
      )}
    </div>
  );
};
