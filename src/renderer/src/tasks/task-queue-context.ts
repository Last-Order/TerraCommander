import { createContext, useContext } from 'react';
import type { TaskQueue } from './task-queue';

export const TaskQueueContext = createContext<TaskQueue | null>(null);

export function useTaskQueue(): TaskQueue {
  const queue = useContext(TaskQueueContext);
  if (!queue) throw new Error('Task queue is unavailable outside the workspace.');
  return queue;
}
