import type { QueueTask, TaskDefinitions, TaskMessage } from './task-types';

export interface TaskRowModel {
  typeLabel: TaskMessage;
  title: readonly { text: string; secondary?: boolean }[];
  summary?: string;
}

export type TaskPresenter<Definitions extends TaskDefinitions> = (
  task: QueueTask<Definitions>,
) => TaskRowModel;
