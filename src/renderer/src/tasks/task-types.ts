import type { StoreApi } from 'zustand';
import type {
  TaskControlAvailability,
  TaskControls,
  TaskFailure,
  TaskGroupOutcome,
  TaskGroupPreparation,
  TaskGroupState,
  TaskGroupSummary,
  TaskGroupViewItem,
  TaskMessage,
  TaskPreparationIssue,
  TaskProgress,
  TaskStatus,
  TaskViewItem,
} from '../../../shared/tasks';

export type {
  TaskControlAvailability,
  TaskControls,
  TaskFailure,
  TaskGroupOutcome,
  TaskGroupPreparation,
  TaskGroupState,
  TaskGroupSummary,
  TaskGroupViewItem,
  TaskMessage,
  TaskPreparationIssue,
  TaskProgress,
  TaskStatus,
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
