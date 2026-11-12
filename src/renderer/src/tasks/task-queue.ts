import { createStore } from 'zustand/vanilla';
import { isActiveTask } from './task-selectors';
import type {
  QueueTask,
  TaskDefinitions,
  TaskFailure,
  TaskHandlers,
  TaskRequest,
  TaskType,
} from './task-types';

/** Session-owned queue: execution continues when dialogs, panels or directories are closed. */
export class TaskQueue<Definitions extends TaskDefinitions> {
  readonly store = createStore<{ tasks: readonly QueueTask<Definitions>[] }>()(() => ({
    tasks: [],
  }));
  private nextId = 0;
  private running = false;
  private readonly conflicts = new Map<number, readonly string[]>();

  constructor(private readonly handlers: TaskHandlers<Definitions>) {}

  enqueue<Type extends TaskType<Definitions>>(request: TaskRequest<Definitions, Type>): boolean {
    const keys = this.handlers[request.type].conflictKeys(request.input);
    if ([...this.conflicts.values()].some((pending) => keys.some((key) => pending.includes(key))))
      return false;

    const task: QueueTask<Definitions, Type> = { id: ++this.nextId, request, status: 'queued' };
    this.conflicts.set(task.id, keys);
    this.store.setState(({ tasks }) => ({ tasks: [...tasks, task] }));
    void this.drain();
    return true;
  }

  clearFinished(): void {
    this.store.setState(({ tasks }) => ({ tasks: tasks.filter(isActiveTask) }));
  }

  private update(task: QueueTask<Definitions>): void {
    this.store.setState(({ tasks }) => ({
      tasks: tasks.map((previous) => (previous.id === task.id ? task : previous)),
    }));
  }

  private async invokeHook(taskId: number, hook: () => void | Promise<void>): Promise<void> {
    try {
      await hook();
    } catch {
      // Never expose provider errors or turn an already successful write into a failed task.
      console.error('Task result callback failed.', { taskId });
    }
  }

  private async execute<Type extends TaskType<Definitions>>(
    task: QueueTask<Definitions, Type>,
  ): Promise<void> {
    const handler = this.handlers[task.request.type];
    const input = task.request.input;
    this.update({ ...task, status: 'running' });
    let result: Definitions[Type]['result'];
    try {
      result = await handler.execute(input, {
        reportProgress: (progress) => {
          const current = this.store.getState().tasks.find(({ id }) => id === task.id);
          if (current?.status === 'running') {
            // Updating progress preserves the mapped union's request/result relationship.
            this.update({ ...current, progress } as QueueTask<Definitions>);
          }
        },
      });
    } catch (error) {
      let failure: TaskFailure;
      try {
        failure = handler.toFailure(error);
      } catch {
        console.error('Task error mapping failed.', { taskId: task.id });
        failure = { code: 'unknown', message: { key: 'tasks:unknownError' } };
      }
      await this.invokeHook(task.id, () => handler.onFailure?.(input, failure));
      this.finish({ id: task.id, request: task.request, status: 'failed', failure });
      return;
    }
    await this.invokeHook(task.id, () => handler.onSuccess?.(input, result));
    this.finish({ id: task.id, request: task.request, status: 'completed', result });
  }

  private finish(task: QueueTask<Definitions>): void {
    this.conflicts.delete(task.id);
    this.update(task);
  }

  private async drain(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      let task: QueueTask<Definitions> | undefined;
      while ((task = this.store.getState().tasks.find(({ status }) => status === 'queued'))) {
        await this.execute(task);
      }
    } finally {
      this.running = false;
    }
  }
}
