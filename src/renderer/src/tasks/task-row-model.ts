import { presentGroupStatus, type TaskRowStatus } from '@shared/task-selectors';
import type { TaskGroupViewItem, TaskMessage, TaskViewItem } from './task-types';

export { presentGroupStatus, type TaskRowStatus };

export interface TaskRowModel {
  compact?: boolean;
  typeLabel: TaskMessage;
  title: readonly { text: string; secondary?: boolean }[];
  titleNote?: TaskMessage;
  summary?: string;
  resultMessage?: TaskMessage;
}

export type TaskPresenter<TTask extends TaskViewItem = TaskViewItem> = (
  task: TTask,
) => TaskRowModel;

export type TaskGroupPresenter<TGroup extends TaskGroupViewItem = TaskGroupViewItem> = (
  group: TGroup,
) => TaskRowModel;
