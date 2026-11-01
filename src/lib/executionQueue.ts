import {
  ExecutionQueue,
  ExecutionTask,
  ExecutionTaskStatus,
  ReviewFixPlan,
  ReviewFixTask
} from '../types';

export function createQueueFromReviewPlan(
  plan: ReviewFixPlan,
  messageId?: string
): ExecutionQueue {
  const tasks: ExecutionTask[] = plan.tasks.map((t, i) => ({
    id: t.id || String(i + 1),
    title: t.title,
    description: t.description,
    ...(t.file ? { file: t.file } : {}),
    status: 'pending' as const
  }));
  return {
    id: `queue-${Date.now()}`,
    summary: plan.summary || 'Review fix tasks',
    tasks,
    activeTaskId: null,
    updatedAt: Date.now(),
    ...(messageId ? { seededFromMessageId: messageId } : {})
  };
}

export function queueToReviewPlan(queue: ExecutionQueue): ReviewFixPlan {
  return {
    summary: queue.summary,
    tasks: queue.tasks.map(({ id, title, description, file, status, failureNote }) => ({
      id,
      title,
      description,
      ...(file ? { file } : {}),
      status,
      ...(failureNote ? { failureNote } : {})
    }))
  };
}

export function getActiveTask(queue: ExecutionQueue | null | undefined): ExecutionTask | undefined {
  if (!queue?.activeTaskId) return undefined;
  return queue.tasks.find(t => t.id === queue.activeTaskId);
}

export function pickNextPending(queue: ExecutionQueue): ExecutionTask | undefined {
  return queue.tasks.find(t => t.status === 'pending' || t.status === 'failed');
}

export function hasOpenTasks(queue: ExecutionQueue | null | undefined): boolean {
  if (!queue?.tasks.length) return false;
  return queue.tasks.some(t => t.status === 'pending' || t.status === 'failed' || t.status === 'in_progress');
}

export function allTasksCompleted(queue: ExecutionQueue | null | undefined): boolean {
  if (!queue?.tasks.length) return false;
  return queue.tasks.every(t => t.status === 'completed');
}

function touch(queue: ExecutionQueue, patch: Partial<ExecutionQueue>): ExecutionQueue {
  return { ...queue, ...patch, updatedAt: Date.now() };
}

function setStatus(
  queue: ExecutionQueue,
  taskId: string,
  status: ExecutionTaskStatus,
  failureNote?: string
): ExecutionQueue {
  return touch(queue, {
    tasks: queue.tasks.map(t =>
      t.id === taskId
        ? {
            ...t,
            status,
            ...(status === 'failed' && failureNote ? { failureNote } : {}),
            ...(status === 'completed' ? { failureNote: undefined } : {})
          }
        : t
    )
  });
}

/** Mark task in progress and set activeTaskId. */
export function markInProgress(queue: ExecutionQueue, taskId: string): ExecutionQueue {
  return touch(setStatus(queue, taskId, 'in_progress'), { activeTaskId: taskId });
}

export function markCompleted(queue: ExecutionQueue, taskId: string): ExecutionQueue {
  const next = setStatus(queue, taskId, 'completed');
  return touch(next, {
    activeTaskId: next.activeTaskId === taskId ? null : next.activeTaskId
  });
}

export function markFailed(
  queue: ExecutionQueue,
  taskId: string,
  note: string
): ExecutionQueue {
  return touch(setStatus(queue, taskId, 'failed', note || 'Reviewer reported failure'), {
    activeTaskId: taskId
  });
}

export interface ReviewDelta {
  taskId: string;
  verdict: 'completed' | 'failed';
  notes: string;
}

/** Apply a reviewer delta onto the durable queue (never replaces the task list). */
export function applyReviewDelta(queue: ExecutionQueue, delta: ReviewDelta): ExecutionQueue {
  const id = delta.taskId || queue.activeTaskId || '';
  const task = queue.tasks.find(t => t.id === id) || getActiveTask(queue);
  if (!task) return queue;
  if (delta.verdict === 'completed') return markCompleted(queue, task.id);
  return markFailed(queue, task.id, delta.notes || 'Not done correctly');
}

/** Prompt block for Reviewer when verifying one active task. */
export function formatQueueForReviewer(queue: ExecutionQueue, active: ExecutionTask): string {
  const lines = queue.tasks.map(t => {
    const mark =
      t.status === 'completed'
        ? '[done]'
        : t.status === 'failed'
          ? '[failed]'
          : t.status === 'in_progress'
            ? '[active]'
            : '[pending]';
    const where = t.file ? ` (${t.file})` : '';
    return `- ${mark} #${t.id} ${t.title}${where}`;
  });
  return `## Durable task list (owned by Planner — do NOT invent a new list)
Summary: ${queue.summary}
${lines.join('\n')}

## Active task to verify (#${active.id})
Title: ${active.title}
${active.file ? `File: ${active.file}\n` : ''}Description: ${active.description}
${active.failureNote ? `Previous failure note: ${active.failureNote}\n` : ''}
Verify ONLY this active task against the files just written. End with <review_delta task_id="${active.id}"> — not a new <review_plan>.`;
}

/** Prompt for Planner/Coder for a single queue task. */
export function formatActiveTaskForPlanner(
  queue: ExecutionQueue,
  task: ExecutionTask,
  reviewNotes?: string
): ReviewFixPlan {
  const remaining = queue.tasks.filter(
    t => t.id !== task.id && (t.status === 'pending' || t.status === 'failed')
  ).length;
  return {
    summary: `${queue.summary} — active task #${task.id}${remaining ? ` (${remaining} more after this)` : ''}`,
    tasks: [
      {
        id: task.id,
        title: task.title,
        description:
          (task.failureNote
            ? `PREVIOUS REVIEW FAILURE: ${task.failureNote}\n\n`
            : '') +
          task.description +
          (reviewNotes ? `\n\nLatest reviewer notes: ${reviewNotes}` : ''),
        ...(task.file ? { file: task.file } : {}),
        status: task.status
      }
    ]
  };
}

export function taskAsReviewFix(task: ExecutionTask): ReviewFixTask {
  return {
    id: task.id,
    title: task.title,
    description: task.description,
    ...(task.file ? { file: task.file } : {}),
    status: task.status,
    ...(task.failureNote ? { failureNote: task.failureNote } : {})
  };
}
