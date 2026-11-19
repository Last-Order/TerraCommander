import type {
  TaskGroup,
  TaskGroupDefinitions,
  TaskGroupOutcome,
  TaskGroupPreparation,
  TaskGroupRequest,
  TaskGroupState,
  TaskGroupSummary,
  TaskStatus,
} from './types';

export function summarizeGroup<Definitions extends TaskGroupDefinitions>(
  id: number,
  request: TaskGroupRequest<Definitions>,
  tasks: readonly { status: TaskStatus }[],
  closed: boolean,
  phase: TaskGroupState['phase'],
  preparation: TaskGroupPreparation,
): TaskGroup<Definitions> {
  const summary: TaskGroupSummary = {
    total: tasks.length,
    queued: 0,
    running: 0,
    paused: 0,
    completed: 0,
    failed: 0,
    cancelled: 0,
    skipped: 0,
  };
  for (const task of tasks) summary[task.status]++;
  const sealed = closed && preparation.status !== 'queued' && preparation.status !== 'running';
  const preparationFailed = preparation.status === 'failed' || preparation.issues.length > 0;
  let outcome: TaskGroupOutcome;
  if (summary.failed || preparationFailed)
    outcome = summary.completed || summary.skipped ? 'partial' : 'failed';
  else if (summary.cancelled || preparation.status === 'cancelled')
    outcome = summary.completed || summary.skipped ? 'partial' : 'cancelled';
  else outcome = 'completed';
  const state: TaskGroupState = phase === 'settled' ? { phase: 'settled', outcome } : { phase };
  const completed = summary.completed + summary.failed + summary.cancelled + summary.skipped;
  return {
    id,
    request,
    sealed,
    state,
    summary,
    preparation,
    progress:
      sealed && summary.total > 0
        ? { kind: 'determinate', completed, total: summary.total, unit: 'items' }
        : (preparation.progress ?? {
            kind: 'indeterminate',
            stage: { key: 'tasks:generatingTasks' },
          }),
  };
}
