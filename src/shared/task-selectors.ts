import type { TaskGroupPreparation, TaskGroupState, TaskGroupSummary, TaskStatus } from './tasks';

export type TaskRowStatus = TaskStatus | 'partial';

export interface PresentableGroup {
  id: number;
  state: TaskGroupState;
  sealed: boolean;
  preparation: Pick<TaskGroupPreparation, 'status'>;
  summary: Pick<TaskGroupSummary, 'running' | 'queued' | 'paused'>;
}

export function presentGroupStatus(group: Omit<PresentableGroup, 'id'>): TaskRowStatus {
  if (group.state.phase === 'settled') return group.state.outcome;
  if (group.preparation.status === 'queued' && !group.summary.running) return 'queued';
  if (!group.sealed || group.summary.running || group.state.phase === 'settling') return 'running';
  if (group.summary.queued) return 'queued';
  if (group.summary.paused) return 'paused';
  return 'running';
}

export function topLevelEntries<
  TTask extends { id: number; status: TaskStatus; groupId?: number | undefined },
  TGroup extends PresentableGroup,
>(tasks: readonly TTask[], groups: readonly TGroup[]) {
  return [
    ...tasks
      .filter((task) => task.groupId === undefined)
      .map((task) => ({ kind: 'task' as const, id: task.id, status: task.status, task })),
    ...groups.map((group) => ({
      kind: 'group' as const,
      id: group.id,
      status: presentGroupStatus(group),
      group,
    })),
  ].sort((left, right) => left.id - right.id);
}

export function isActiveTask({ status }: { status: TaskStatus }): boolean {
  return status === 'queued' || status === 'running';
}

export function isFinishedTask({ status }: { status: TaskStatus }): boolean {
  return (
    status === 'completed' || status === 'failed' || status === 'cancelled' || status === 'skipped'
  );
}

export function isFinishedGroup(group: { state: TaskGroupState }): boolean {
  return group.state.phase === 'settled';
}

export function summarizeTasks(tasks: readonly { status: TaskRowStatus }[]) {
  let active = 0;
  let failed = 0;
  let paused = 0;
  for (const task of tasks) {
    if (task.status === 'queued' || task.status === 'running') active++;
    if (task.status === 'failed' || task.status === 'partial') failed++;
    if (task.status === 'paused') paused++;
  }
  return { active, failed, paused };
}
