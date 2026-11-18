import type { QueueTask, TaskDefinitions, TaskStatus } from './task-types';
import type { TaskGroup, TaskGroupDefinitions } from './task-group-types';
import { presentGroupStatus, type TaskRowStatus } from './task-row-model';

export function topLevelEntries<
  Definitions extends TaskDefinitions,
  Groups extends TaskGroupDefinitions,
>(tasks: readonly QueueTask<Definitions>[], groups: readonly TaskGroup<Groups>[]) {
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

export function isFinishedGroup(group: Pick<TaskGroup, 'state'>): boolean {
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
