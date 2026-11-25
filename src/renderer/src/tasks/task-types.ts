import type { StoreApi } from 'zustand';
import type {
  TaskFailure,
  TaskGroupPreparation,
  TaskGroupSummary,
  TaskGroupViewItem,
  TaskMessage,
  TaskProgress,
  TaskViewItem,
} from '@shared/tasks';

export type {
  TaskFailure,
  TaskGroupPreparation,
  TaskGroupSummary,
  TaskGroupViewItem,
  TaskMessage,
  TaskProgress,
  TaskViewItem,
};

export interface TaskQueueViewSnapshot<
  TTask extends TaskViewItem = TaskViewItem,
  TGroup extends TaskGroupViewItem = TaskGroupViewItem,
> {
  tasks: readonly TTask[];
  groups: readonly TGroup[];
}

export interface TaskQueueViewClient<
  TTask extends TaskViewItem = TaskViewItem,
  TGroup extends TaskGroupViewItem = TaskGroupViewItem,
> {
  readonly store: StoreApi<TaskQueueViewSnapshot<TTask, TGroup>>;
  pause(taskId: number): Promise<void>;
  resume(taskId: number): Promise<void>;
  cancel(taskId: number): Promise<void>;
  retry(taskId: number): Promise<void>;
  clearFinished(): Promise<void>;
}
