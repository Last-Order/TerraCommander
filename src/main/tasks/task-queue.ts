import { isFinishedTask } from '@shared/task-selectors';
import { TaskConflictLedger } from './conflict-ledger';
import { TaskGroupCoordinator } from './group-coordinator';
import type {
  QueueTask,
  TaskDefinitions,
  TaskExecutionOutcome,
  TaskFailure,
  TaskGroupDefinitions,
  TaskGroupHooks,
  TaskGroupRequest,
  TaskHandlers,
  TaskMembership,
  TaskProgress,
  TaskQueueChange,
  TaskQueueOptions,
  TaskQueueSnapshot,
  TaskRequest,
  TaskState,
  TaskType,
} from './types';

type StoreListener<Definitions extends TaskDefinitions, Groups extends TaskGroupDefinitions> = (
  state: TaskQueueSnapshot<Definitions, Groups>,
  previous: TaskQueueSnapshot<Definitions, Groups>,
  change: TaskQueueChange,
) => void;

/** Domain-neutral priority queue with bounded category concurrency and cooperative cancellation. */
export class TaskQueue<
  Definitions extends TaskDefinitions,
  Groups extends TaskGroupDefinitions = TaskGroupDefinitions,
  Category extends string = string,
> {
  private state: TaskQueueSnapshot<Definitions, Groups> = { tasks: [], groups: [] };
  private readonly listeners = new Set<StoreListener<Definitions, Groups>>();
  readonly store = {
    getState: (): TaskQueueSnapshot<Definitions, Groups> => this.state,
    subscribe: (listener: StoreListener<Definitions, Groups>) => {
      this.listeners.add(listener);
      return () => {
        this.listeners.delete(listener);
      };
    },
  };

  private nextId = 0;
  private draining = false;
  private readonly concurrencyLimits: Record<Category, number>;
  private readonly running: Record<string, number> = {};
  private readonly conflicts = new TaskConflictLedger();
  private readonly executions = new Map<number, symbol>();
  private readonly order = new Map<number, number>();
  private nextOrder = 0;
  private readonly controllers = new Map<number, AbortController>();
  private readonly retrying = new Set<number>();
  private readonly retryRuns = new Map<number, Promise<void>>();
  private readonly taskRuns = new Map<number, Promise<void>>();
  private readonly groupCoordinator: TaskGroupCoordinator<Definitions, Groups>;
  private disposed = false;
  private disposal: Promise<void> | undefined;

  constructor(
    private readonly handlers: TaskHandlers<Definitions, Category>,
    options: TaskQueueOptions<Category>,
  ) {
    this.concurrencyLimits = { ...options.concurrencyLimits };
    for (const category of Object.keys(options.concurrencyLimits)) this.running[category] = 0;
    this.groupCoordinator = new TaskGroupCoordinator({
      conflicts: this.conflicts,
      nextId: () => ++this.nextId,
      getTasks: () => this.state.tasks,
      getGroups: () => this.state.groups,
      setGroups: (groups) => this.setState({ groups }),
      subscribe: (listener) => this.store.subscribe(listener),
      enqueue: (request, membership) => this.enqueue(request, membership),
      invokeHook: (id, hook) => this.invokeHook(id, hook),
      isDisposed: () => this.disposed,
    });
  }

  createGroup(
    request: TaskGroupRequest<Groups>,
    hooks: TaskGroupHooks<Definitions> = {},
  ): number | undefined {
    return this.groupCoordinator.createGroup(request, hooks);
  }

  sealGroup(id: number): void {
    this.groupCoordinator.sealGroup(id);
  }

  /** Updates a category's concurrency limit and drains queued tasks if capacity increased. */
  setConcurrencyLimit(category: Category, limit: number): void {
    if (!Number.isInteger(limit) || limit < 1) {
      throw new RangeError(`Concurrency limit for ${category} must be a positive integer.`);
    }
    if (this.concurrencyLimits[category] === limit) return;
    this.concurrencyLimits[category] = limit;
    this.drain();
  }

  enqueue<Type extends TaskType<Definitions>>(
    request: TaskRequest<Definitions, Type>,
    membership: TaskMembership = {},
  ): boolean {
    if (this.disposed) return false;
    const group =
      membership.groupId === undefined
        ? undefined
        : this.state.groups.find((item) => item.id === membership.groupId);
    if (membership.groupId !== undefined && (!group || group.sealed)) return false;
    if (
      membership.memberKey &&
      membership.groupId !== undefined &&
      this.groupCoordinator.hasMember(membership.groupId, membership.memberKey)
    )
      return false;
    const keys =
      request.resources ?? this.handlers[request.type].conflictKeys?.(request.input) ?? [];
    if (this.conflicts.hasConflicts(keys, membership.groupId)) return false;

    const task: QueueTask<Definitions, Type> = {
      id: ++this.nextId,
      request,
      status: 'queued',
      ...membership,
    };
    if (membership.groupId !== undefined) {
      this.groupCoordinator.registerMember(membership.groupId, membership.memberKey);
    }
    this.conflicts.reserveTask(task.id, keys);
    this.order.set(task.id, ++this.nextOrder);
    this.setState(({ tasks }) => ({ tasks: [...tasks, task] }));
    this.groupCoordinator.sync();
    this.drain();
    return true;
  }

  clearFinished(): void {
    const { finishedGroupIds } = this.groupCoordinator.clearFinished();
    const removable = (task: QueueTask<Definitions>) =>
      isFinishedTask(task) && (task.groupId === undefined || finishedGroupIds.has(task.groupId));
    for (const task of this.state.tasks) {
      if (!removable(task) || task.groupId !== undefined) continue;
      void this.handlers[task.request.type].release?.(task.request.input).catch(() => {
        console.error('Task resource release failed.', { taskId: task.id });
      });
    }
    this.setState(({ tasks, groups }) => ({
      tasks: tasks.filter((task) => !removable(task)),
      groups: groups.filter((group) => !finishedGroupIds.has(group.id)),
    }));
  }

  canRetry(task: QueueTask<Definitions>): boolean {
    return (
      !this.retrying.has(task.id) &&
      task.status === 'failed' &&
      this.groupCoordinator.canRetryMember(task.groupId) &&
      !this.disposed &&
      (this.handlers[task.request.type].canRetry?.(task.request.input) ?? true) &&
      this.handlers[task.request.type].retry !== undefined
    );
  }

  retry(id: number): Promise<void> {
    const run = this.executeRetry(id).finally(() => {
      if (this.retryRuns.get(id) === run) this.retryRuns.delete(id);
    });
    this.retryRuns.set(id, run);
    return run;
  }

  private async executeRetry(id: number): Promise<void> {
    const task = this.state.tasks.find((candidate) => candidate.id === id);
    if (!task || !this.canRetry(task)) return;
    const handler = this.handlers[task.request.type];
    const keys = task.request.resources ?? handler.conflictKeys?.(task.request.input) ?? [];
    const extraConflicts = this.groupCoordinator.extraRetryConflicts(task.groupId);
    if (this.conflicts.hasConflicts([...keys, ...extraConflicts], task.groupId)) return;
    this.groupCoordinator.reopenForRetry(task.groupId);
    this.conflicts.reserveTask(id, keys);
    this.order.set(id, ++this.nextOrder);
    this.retrying.add(id);
    this.update({ id, request: task.request, status: 'queued' });
    try {
      await handler.retry?.(task.request.input);
      if (this.disposed) {
        this.finish({ id, request: task.request, status: 'cancelled' });
        return;
      }
      this.update({ id, request: task.request, status: 'queued' });
    } catch (error) {
      this.finish({
        id,
        request: task.request,
        status: 'failed',
        failure: handler.toFailure(error),
      });
    } finally {
      this.retrying.delete(id);
    }
    this.drain();
  }

  supportsControl(task: QueueTask<Definitions>, control: 'pause' | 'cancel'): boolean {
    return this.handlers[task.request.type][control] !== undefined;
  }

  canCancel(task: QueueTask<Definitions>): boolean {
    return (
      !this.retrying.has(task.id) &&
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
    const task = this.state.tasks.find((candidate) => candidate.id === id);
    if (!task || task.status !== 'running' || !this.canPause(task)) return;
    const execution = this.executions.get(id);
    this.updateRunning(task, { controlRequest: 'pause' });
    try {
      await this.handlers[task.request.type].pause?.(task.request.input);
    } catch {
      const current = this.state.tasks.find((candidate) => candidate.id === id);
      if (current?.status === 'running' && this.executions.get(id) === execution)
        this.updateRunning(current, { controlRequest: undefined });
    }
  }

  canResume(task: QueueTask<Definitions>): boolean {
    return task.status === 'paused' && task.controlRequest === undefined;
  }

  resume(id: number): void {
    if (this.disposed) return;
    const task = this.state.tasks.find((candidate) => candidate.id === id);
    if (!task || task.status !== 'paused' || !this.canResume(task)) return;
    this.order.set(id, ++this.nextOrder);
    this.update({
      id: task.id,
      request: task.request,
      status: 'queued',
      ...(task.progress ? { progress: task.progress } : {}),
    });
    this.drain();
  }

  async cancel(id: number): Promise<void> {
    const task = this.state.tasks.find((candidate) => candidate.id === id);
    if (
      !task ||
      (task.status !== 'queued' && task.status !== 'paused' && task.status !== 'running') ||
      !this.canCancel(task)
    )
      return;
    const execution = this.executions.get(id);
    this.controllers.get(id)?.abort();
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
        const current = this.state.tasks.find((candidate) => candidate.id === id);
        if (current?.status === 'running' && this.executions.get(id) === execution)
          this.updateRunning(current, { controlRequest: undefined });
      }
    } finally {
      this.drain();
    }
  }

  dispose(): Promise<void> {
    this.disposal ??= this.disposeQueue();
    return this.disposal;
  }

  private async disposeQueue(): Promise<void> {
    this.disposed = true;
    await Promise.allSettled([
      this.groupCoordinator.disposePreparations(),
      ...this.state.tasks
        .filter((task) => !isFinishedTask(task))
        .map((task) => this.cancel(task.id)),
    ]);
    await Promise.allSettled(this.taskRuns.values());
    await Promise.allSettled(this.retryRuns.values());
    await Promise.allSettled(
      this.state.tasks.filter((task) => !isFinishedTask(task)).map((task) => this.cancel(task.id)),
    );
    await this.groupCoordinator.waitForSettlementsAndRelease();
    await Promise.all(
      this.state.tasks
        .filter(
          (task) =>
            task.groupId === undefined || !this.groupCoordinator.hasReleaseHook(task.groupId),
        )
        .map((task) =>
          this.invokeHook(task.id, () =>
            this.handlers[task.request.type].release?.(task.request.input),
          ),
        ),
    );
  }

  private setState(
    updater:
      | Partial<TaskQueueSnapshot<Definitions, Groups>>
      | ((
          current: TaskQueueSnapshot<Definitions, Groups>,
        ) => Partial<TaskQueueSnapshot<Definitions, Groups>>),
    change: TaskQueueChange = { kind: 'snapshot' },
  ): void {
    const previous = this.state;
    const patch = typeof updater === 'function' ? updater(previous) : updater;
    this.state = {
      tasks: patch.tasks ?? previous.tasks,
      groups: patch.groups ?? previous.groups,
    };
    for (const listener of [...this.listeners]) listener(this.state, previous, change);
  }

  private update(task: QueueTask<Definitions>, change?: TaskQueueChange): void {
    const previous = this.state.tasks.find((item) => item.id === task.id);
    this.setState(
      ({ tasks }) => ({
        tasks: tasks.map((item): QueueTask<Definitions> => {
          if (item.id !== task.id) return item;
          if (item.groupId === undefined && item.memberKey === undefined) return task;
          return {
            ...task,
            ...(item.groupId !== undefined ? { groupId: item.groupId } : {}),
            ...(item.memberKey !== undefined ? { memberKey: item.memberKey } : {}),
          } as QueueTask<Definitions>;
        }),
      }),
      change,
    );
    if (previous?.status !== task.status) this.groupCoordinator.sync();
  }

  private updateRunning(
    task: QueueTask<Definitions>,
    changes: Partial<Extract<TaskState<unknown>, { status: 'running' }>> & {
      progress?: TaskProgress;
    },
    change?: TaskQueueChange,
  ): void {
    if (task.status !== 'running') return;
    this.update(
      {
        id: task.id,
        request: task.request,
        status: 'running',
        controls: task.controls,
        ...(task.controlRequest ? { controlRequest: task.controlRequest } : {}),
        ...(task.progress ? { progress: task.progress } : {}),
        ...changes,
      },
      change,
    );
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
    const controller = new AbortController();
    this.controllers.set(task.id, controller);
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
        taskId: task.id,
        signal: controller.signal,
        ...(task.groupId !== undefined ? { groupId: task.groupId } : {}),
        reportProgress: (progress) => {
          const current = this.state.tasks.find(({ id }) => id === task.id);
          if (current?.status === 'running' && this.executions.get(task.id) === execution) {
            this.updateRunning(current, { progress }, { kind: 'task-progress', taskId: task.id });
          }
        },
        reportControls: (controls) => {
          const current = this.state.tasks.find(({ id }) => id === task.id);
          if (
            current?.status === 'running' &&
            this.executions.get(task.id) === execution &&
            (current.controls.cancellable !== controls.cancellable ||
              current.controls.pausable !== controls.pausable)
          )
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
      case 'failed':
        await this.invokeHook(task.id, () => handler.onFailure?.(input, outcome.failure));
        this.finish({
          id: task.id,
          request: task.request,
          status: 'failed',
          failure: outcome.failure,
        });
        return;
      case 'paused': {
        if (outcome.failure) {
          const failure = outcome.failure;
          await this.invokeHook(task.id, () => handler.onFailure?.(input, failure));
        }
        const current = this.state.tasks.find(({ id }) => id === task.id);
        if (current)
          this.update({
            id: task.id,
            request: task.request,
            status: 'paused',
            ...(current.progress ? { progress: current.progress } : {}),
            ...(outcome.failure ? { failure: outcome.failure } : {}),
          });
        return;
      }
      case 'cancelled':
      case 'skipped':
        this.finish({ id: task.id, request: task.request, status: outcome.status });
        return;
      case 'completed':
        await this.invokeHook(task.id, () => handler.onSuccess?.(input, outcome.result));
        this.finish({
          id: task.id,
          request: task.request,
          status: outcome.status,
          result: outcome.result,
        });
    }
  }

  private finish(task: QueueTask<Definitions>): void {
    this.conflicts.releaseTask(task.id);
    this.executions.delete(task.id);
    this.controllers.delete(task.id);
    this.order.delete(task.id);
    this.update(task);
  }

  private drain(): void {
    if (this.draining || this.disposed) return;
    this.draining = true;
    try {
      let task: QueueTask<Definitions> | undefined;
      while ((task = this.nextRunnable())) {
        const category = this.handlers[task.request.type].category;
        const taskId = task.id;
        this.running[category] = (this.running[category] ?? 0) + 1;
        const execution: Promise<void> = this.execute(task).finally(() => {
          if (this.taskRuns.get(taskId) === execution) this.taskRuns.delete(taskId);
          this.running[category] = (this.running[category] ?? 1) - 1;
          this.drain();
        });
        this.taskRuns.set(task.id, execution);
      }
    } finally {
      this.draining = false;
    }
  }

  private nextRunnable(): QueueTask<Definitions> | undefined {
    let next: QueueTask<Definitions> | undefined;
    for (const task of this.state.tasks) {
      const category = this.handlers[task.request.type].category;
      const running = this.running[category] ?? 0;
      if (
        task.status !== 'queued' ||
        task.controlRequest !== undefined ||
        this.retrying.has(task.id) ||
        running >= this.concurrencyLimits[category]
      )
        continue;
      if (!next || (this.order.get(task.id) ?? 0) < (this.order.get(next.id) ?? 0)) next = task;
    }
    return next;
  }
}
