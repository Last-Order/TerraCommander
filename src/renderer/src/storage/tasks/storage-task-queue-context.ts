import { createContext, useContext } from 'react';
import type { StorageTaskClient } from './storage-task-client';

export const StorageTaskQueueContext = createContext<StorageTaskClient | null>(null);

export function useStorageTaskQueue(): StorageTaskClient {
  const queue = useContext(StorageTaskQueueContext);
  if (!queue) throw new Error('StorageTaskQueueContext is not configured.');
  return queue;
}
