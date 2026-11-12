import type { TaskStatus } from './task-types';

export function isActiveTask({ status }: { status: TaskStatus }): boolean {
  return status === 'queued' || status === 'running';
}

export function isFinishedTask(task: { status: TaskStatus }): boolean {
  return !isActiveTask(task);
}

export function summarizeTasks(tasks: readonly { status: TaskStatus }[]) {
  let active = 0;
  let failed = 0;
  for (const task of tasks) {
    if (isActiveTask(task)) active++;
    if (task.status === 'failed') failed++;
  }
  return { active, failed };
}
