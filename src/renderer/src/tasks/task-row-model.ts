import type { QueueTask, TaskDefinitions, TaskMessage, TaskStatus } from './task-types';
import type { TaskGroup, TaskGroupDefinitions } from './task-group-types';

export type TaskRowStatus = TaskStatus | 'partial';

export interface TaskRowModel {
  compact?: boolean;
  typeLabel: TaskMessage;
  title: readonly { text: string; secondary?: boolean }[];
  summary?: string;
  resultMessage?: TaskMessage;
}

export type TaskPresenter<Definitions extends TaskDefinitions> = (
  task: QueueTask<Definitions>,
) => TaskRowModel;

export type TaskGroupPresenter<Definitions extends TaskGroupDefinitions> = (
  group: TaskGroup<Definitions>,
) => TaskRowModel;

export function presentGroupStatus(
  group: Pick<TaskGroup, 'state' | 'sealed' | 'preparation' | 'summary'>,
): TaskRowStatus {
  if (group.state.phase === 'settled') return group.state.outcome;
  if (group.preparation.status === 'queued' && !group.summary.running) return 'queued';
  if (!group.sealed || group.summary.running || group.state.phase === 'settling') return 'running';
  if (group.summary.queued) return 'queued';
  if (group.summary.paused) return 'paused';
  return 'running';
}
