import { createContext, useContext } from 'react';
import type { TaskQueue } from '../../tasks/task-queue';
import type { StorageTaskDefinitions } from './storage-task-types';

export const StorageTaskQueueContext = createContext<TaskQueue<StorageTaskDefinitions> | null>(
  null,
);

export function useStorageTaskQueue(): TaskQueue<StorageTaskDefinitions> {
  const queue = useContext(StorageTaskQueueContext);
  if (!queue) throw new Error('Task queue is unavailable outside the workspace.');
  return queue;
}
