import { createStore } from 'zustand/vanilla';
import type { Entry, EntryRef } from '../../../shared/storage';
import { errorKey, type StorageErrorKey } from '../storage/storage-client';

export interface RenameTaskRequest {
  type: 'rename';
  parent: EntryRef;
  entry: Entry;
  name: string;
  directoryPath: string;
}

export type TaskRequest = RenameTaskRequest;
export type QueueTask = { id: number; request: TaskRequest } & (
  | { status: 'queued' | 'running' }
  | { status: 'completed'; result: Entry }
  | { status: 'failed'; error: StorageErrorKey }
);

interface TaskQueueOptions {
  execute: (request: TaskRequest) => Promise<Entry>;
  onRenamed: (request: RenameTaskRequest, result: Entry) => void;
  onAuthRequired: () => void;
}

/** Session-owned queue: execution continues when dialogs, panels or directories are closed. */
export class TaskQueue {
  readonly store = createStore<{ tasks: readonly QueueTask[] }>()(() => ({ tasks: [] }));
  private nextId = 0;
  private running = false;

  constructor(private readonly options: TaskQueueOptions) {}

  enqueue(request: TaskRequest): boolean {
    const ref = request.entry.ref;
    const blocked = this.store
      .getState()
      .tasks.some(
        (task) =>
          (task.status === 'queued' || task.status === 'running') &&
          task.request.entry.ref.connectionId === ref.connectionId &&
          task.request.entry.ref.spaceId === ref.spaceId &&
          task.request.entry.ref.locator === ref.locator,
      );
    if (blocked) return false;
    const task: QueueTask = { id: ++this.nextId, request, status: 'queued' };
    this.store.setState(({ tasks }) => ({ tasks: [...tasks, task] }));
    void this.drain();
    return true;
  }

  clearFinished(): void {
    this.store.setState(({ tasks }) => ({
      tasks: tasks.filter(({ status }) => status === 'queued' || status === 'running'),
    }));
  }

  private update(task: QueueTask): void {
    this.store.setState(({ tasks }) => ({
      tasks: tasks.map((previous) => (previous.id === task.id ? task : previous)),
    }));
  }

  private async drain(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      let task: QueueTask | undefined;
      while ((task = this.store.getState().tasks.find(({ status }) => status === 'queued'))) {
        this.update({ ...task, status: 'running' });
        let result: Entry;
        try {
          result = await this.options.execute(task.request);
        } catch (failure) {
          const error = errorKey(failure);
          this.update({ id: task.id, request: task.request, status: 'failed', error });
          if (error === 'AuthRequired') this.options.onAuthRequired();
          continue;
        }
        this.options.onRenamed(task.request, result);
        this.update({ id: task.id, request: task.request, status: 'completed', result });
      }
    } finally {
      this.running = false;
    }
  }
}
