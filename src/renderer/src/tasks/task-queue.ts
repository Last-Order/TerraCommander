import { createStore } from 'zustand/vanilla';
import { isFinishedTask } from './task-selectors';
import type {
  QueueTask,
  TaskCategory,
  TaskDefinitions,
  TaskExecutionOutcome,
  TaskFailure,
  TaskHandlers,
  TaskRequest,
  TaskProgress,
  TaskState,
  TaskType,
} from './task-types';

const concurrencyLimits: Readonly<Record<TaskCategory, number>> = {
  operation: 16,
  transfer: 8,
};

/** Session-owned queue: execution continues when dialogs, panels or directories are closed. */
export class TaskQueue<Definitions extends TaskDefinitions> {
  readonly store = createStore<{ tasks: readonly QueueTask<Definitions>[] }>()(() => ({
    tasks: [],
  }));
  private nextId = 0;
  private draining = false;
  private readonly running: Record<TaskCategory, number> = { operation: 0, transfer: 0 };
  private readonly conflicts = new Map<number, readonly string[]>();
  private readonly executions = new Map<number, symbol>();
  private readonly order = new Map<number, number>();
  private nextOrder = 0;

  constructor(private readonly handlers: TaskHandlers<Definitions>) {}

  enqueue<Type extends TaskType<Definitions>>(request: TaskRequest<Definitions, Type>): boolean {
    const keys = this.handlers[request.type].conflictKeys(request.input);
    if ([...this.conflicts.values()].some((pending) => keys.some((key) => pending.includes(key))))
      return false;

    const task: QueueTask<Definitions, Type> = { id: ++this.nextId, request, status: 'queued' };
    this.conflicts.set(task.id, keys);
    this.order.set(task.id, ++this.nextOrder);
    this.store.setState(({ tasks }) => ({ tasks: [...tasks, task] }));
    this.drain();
    return true;
  }

  clearFinished(): void {
    this.store.setState(({ tasks }) => ({ tasks: tasks.filter((task) => !isFinishedTask(task)) }));
  }

  supportsControl(task: QueueTask<Definitions>, control: 'pause' | 'cancel'): boolean {
    return this.handlers[task.request.type][control] !== undefined;
  }

  canCancel(task: QueueTask<Definitions>): boolean {
    return (
      !isFinishedTask(task) &&
      task.controlRequest === undefined &&
      (task.status !== 'running' || task.controls.cancellable) &&
      this.supportsControl(task, 'cancel')
    );
  }

  canPause(task: QueueTask<Definitions>): boolean {
    return (
      task.status === 'running' &&
      task.controlRequest === undefined &&
      task.controls.pausable &&
      this.supportsControl(task, 'pause')
    );
  }

  async pause(id: number): Promise<void> {
    const task = this.store.getState().tasks.find((candidate) => candidate.id === id);
    if (!task || task.status !== 'running' || !this.canPause(task)) return;
    const execution = this.executions.get(id);
    this.updateRunning(task, { controlRequest: 'pause' });
    try {
      await this.handlers[task.request.type].pause?.(task.request.input);
    } catch {
      const current = this.store.getState().tasks.find((candidate) => candidate.id === id);
      if (current?.status === 'running' && this.executions.get(id) === execution)
        this.updateRunning(current, { controlRequest: undefined });
    }
  }

  canResume(task: QueueTask<Definitions>): boolean {
    return task.status === 'paused' && task.controlRequest === undefined;
  }

  resume(id: number): void {
    const task = this.store.getState().tasks.find((candidate) => candidate.id === id);
    if (!task || task.status !== 'paused' || !this.canResume(task)) return;
    this.order.set(id, ++this.nextOrder);
    this.update({ ...task, status: 'queued' });
    this.drain();
  }

  async cancel(id: number): Promise<void> {
    const task = this.store.getState().tasks.find((candidate) => candidate.id === id);
    if (
      !task ||
      (task.status !== 'queued' && task.status !== 'paused' && task.status !== 'running') ||
      !this.canCancel(task)
    )
      return;
    const execution = this.executions.get(id);
    if (task.status === 'running') this.updateRunning(task, { controlRequest: 'cancel' });
    else
      this.update({
        id: task.id,
        request: task.request,
        status: task.status,
        controlRequest: 'cancel',
        ...(task.progress ? { progress: task.progress } : {}),
      });
    try {
      await this.handlers[task.request.type].cancel?.(task.request.input);
      if (task.status !== 'running')
        this.finish({ id, request: task.request, status: 'cancelled' });
    } catch (error) {
      if (task.status !== 'running')
        this.finish({
          id,
          request: task.request,
          status: 'failed',
          failure: this.handlers[task.request.type].toFailure(error),
        });
      else {
        const current = this.store.getState().tasks.find((candidate) => candidate.id === id);
        if (current?.status === 'running' && this.executions.get(id) === execution)
          this.updateRunning(current, { controlRequest: undefined });
      }
    } finally {
      this.drain();
    }
  }

  private update(task: QueueTask<Definitions>): void {
    this.store.setState(({ tasks }) => ({
      tasks: tasks.map((previous) => (previous.id === task.id ? task : previous)),
    }));
  }

  private updateRunning(
    task: QueueTask<Definitions>,
    changes: Partial<Extract<TaskState<unknown>, { status: 'running' }>> & {
      progress?: TaskProgress;
    },
  ): void {
    if (task.status !== 'running') return;
    this.update({
      id: task.id,
      request: task.request,
      status: 'running',
      controls: task.controls,
      ...(task.controlRequest ? { controlRequest: task.controlRequest } : {}),
      ...(task.progress ? { progress: task.progress } : {}),
      ...changes,
    });
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
    const execution = Symbol();
    this.executions.set(task.id, execution);
    this.update({
      id: task.id,
      request: task.request,
      status: 'running',
      controls: { cancellable: handler.cancel !== undefined, pausable: false },
      ...(task.progress ? { progress: task.progress } : {}),
    });
    let outcome: TaskExecutionOutcome<Definitions[Type]['result']>;
    try {
      outcome = await handler.execute(input, {
        reportProgress: (progress) => {
          const current = this.store.getState().tasks.find(({ id }) => id === task.id);
          if (current?.status === 'running' && this.executions.get(task.id) === execution) {
            this.updateRunning(current, { progress });
          }
        },
        reportControls: (controls) => {
          const current = this.store.getState().tasks.find(({ id }) => id === task.id);
          if (current?.status === 'running' && this.executions.get(task.id) === execution)
            this.updateRunning(current, { controls });
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
    switch (outcome.status) {
      case 'paused': {
        const current = this.store.getState().tasks.find(({ id }) => id === task.id);
        if (current)
          this.update({
            id: task.id,
            request: task.request,
            status: 'paused',
            ...(current.progress ? { progress: current.progress } : {}),
          });
        return;
      }
      case 'cancelled':
        this.finish({ id: task.id, request: task.request, status: 'cancelled' });
        return;
      case 'completed':
        await this.invokeHook(task.id, () => handler.onSuccess?.(input, outcome.result));
        this.finish({
          id: task.id,
          request: task.request,
          status: 'completed',
          result: outcome.result,
        });
    }
  }

  private finish(task: QueueTask<Definitions>): void {
    this.conflicts.delete(task.id);
    this.executions.delete(task.id);
    this.order.delete(task.id);
    this.update(task);
  }

  private drain(): void {
    if (this.draining) return;
    this.draining = true;
    try {
      let task: QueueTask<Definitions> | undefined;
      while ((task = this.nextRunnable())) {
        const category = this.handlers[task.request.type].category;
        this.running[category]++;
        void this.execute(task).finally(() => {
          this.running[category]--;
          this.drain();
        });
      }
    } finally {
      this.draining = false;
    }
  }

  private nextRunnable(): QueueTask<Definitions> | undefined {
    let next: QueueTask<Definitions> | undefined;
    for (const task of this.store.getState().tasks) {
      const category = this.handlers[task.request.type].category;
      if (
        task.status !== 'queued' ||
        task.controlRequest !== undefined ||
        this.running[category] >= concurrencyLimits[category]
      )
        continue;
      if (!next || (this.order.get(task.id) ?? 0) < (this.order.get(next.id) ?? 0)) next = task;
    }
    return next;
  }
}
