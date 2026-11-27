import { presentGroupStatus, type TaskRowStatus } from '@shared/task-selectors';
import type { TaskGroupViewItem, TaskMessage, TaskViewItem } from './task-types';

export { presentGroupStatus, type TaskRowStatus };

export interface TaskRowModel {
  typeLabel: TaskMessage;
  title: readonly { text: string; secondary?: boolean }[];
  titleNote?: TaskMessage | undefined;
  summary?: string | undefined;
  stageLabel?: TaskMessage | undefined;
  resultMessage?: TaskMessage | undefined;
}

export type TaskPresenter<TTask extends TaskViewItem = TaskViewItem> = (
  task: TTask,
) => TaskRowModel;

export type TaskGroupPresenter<TGroup extends TaskGroupViewItem = TaskGroupViewItem> = (
  group: TGroup,
) => TaskRowModel;
