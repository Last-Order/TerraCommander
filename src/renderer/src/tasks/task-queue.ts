import { createStore } from 'zustand/vanilla';
import { isFinishedGroup, isFinishedTask } from './task-selectors';
import { summarizeGroup } from './task-group-summary';
import { TaskGroupPreparations } from './task-group-preparations';
import type {
  TaskGroup,
  TaskGroupDefinitions,
  TaskGroupState,
  TaskGroupHooks,
  TaskGroupRequest,
  TaskGroupPreparation,
  TaskMembership,
} from './task-group-types';
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
export class TaskQueue<
  Definitions extends TaskDefinitions,
  Groups extends TaskGroupDefinitions = TaskGroupDefinitions,
> {
  readonly store = createStore<{
    tasks: readonly QueueTask<Definitions>[];
    groups: readonly TaskGroup<Groups>[];
  }>()(() => ({
    tasks: [],
    groups: [],
  }));
  private nextId = 0;
  private draining = false;
  private readonly running: Record<TaskCategory, number> = { operation: 0, transfer: 0 };
  private readonly conflicts = new Map<number, readonly string[]>();
  private readonly executions = new Map<number, symbol>();
  private readonly order = new Map<number, number>();
  private nextOrder = 0;
  private readonly groups = new Map<
    number,
    {
      closed: boolean;
      phase: TaskGroupState['phase'];
      hooks: TaskGroupHooks<Definitions>;
      preparation: TaskGroupPreparation;
    }
  >();
  private readonly groupConflicts = new Map<number, readonly string[]>();
  private readonly controllers = new Map<number, AbortController>();
  private readonly preparations = new TaskGroupPreparations();
  private readonly taskRuns = new Map<number, Promise<void>>();
  private readonly settlements = new Map<number, Promise<void>>();
  private disposed = false;
  private disposal: Promise<void> | undefined;

  constructor(private readonly handlers: TaskHandlers<Definitions>) {}

  createGroup(
    request: TaskGroupRequest<Groups>,
    hooks: TaskGroupHooks<Definitions> = {},
  ): number | undefined {
    if (this.disposed) return undefined;
    const resources = request.resources ?? [];
    if (this.hasConflicts(resources)) return undefined;
    const id = ++this.nextId;
    const preparation: TaskGroupPreparation = {
      status: hooks.prepare ? 'queued' : 'completed',
      issues: [],
    };
    this.groups.set(id, { closed: false, phase: 'active', hooks, preparation });
    this.groupConflicts.set(id, resources);
    const group = summarizeGroup(id, request, [], false, 'active', preparation);
    this.store.setState(({ groups }) => ({ groups: [...groups, group] }));
    if (hooks.prepare) this.preparations.enqueue((signal) => this.prepareGroup(id, signal));
    return id;
  }

  sealGroup(id: number): void {
    const record = this.groups.get(id);
    if (!record) return;
    record.closed = true;
    this.syncGroups();
  }

  hasGroupMember(groupId: number, memberKey: string): boolean {
    return this.store
      .getState()
      .tasks.some((task) => task.groupId === groupId && task.memberKey === memberKey);
  }

  waitForGroupCapacity(groupId: number, signal: AbortSignal, limit = 64): Promise<void> {
    const available = () =>
      this.store
        .getState()
        .tasks.filter((task) => task.groupId === groupId && !isFinishedTask(task)).length < limit;
    if (signal.aborted) return Promise.reject(new Error('Task cancelled'));
    if (available()) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const cleanup = () => {
        unsubscribe();
        signal.removeEventListener('abort', abort);
      };
      const abort = () => {
        cleanup();
        reject(new Error('Task cancelled'));
      };
      const unsubscribe = this.store.subscribe(() => {
        if (available()) {
          cleanup();
          resolve();
        }
      });
      signal.addEventListener('abort', abort, { once: true });
    });
  }

  enqueue<Type extends TaskType<Definitions>>(
    request: TaskRequest<Definitions, Type>,
    membership: TaskMembership = {},
  ): boolean {
    if (this.disposed) return false;
    const group =
      membership.groupId === undefined
        ? undefined
        : this.store.getState().groups.find((item) => item.id === membership.groupId);
    if (membership.groupId !== undefined && (!group || group.sealed)) return false;
    if (
      membership.memberKey &&
      membership.groupId !== undefined &&
      this.hasGroupMember(membership.groupId, membership.memberKey)
    )
      return false;
    const keys = this.handlers[request.type].conflictKeys(request.input);
    if (this.hasConflicts(keys, membership.groupId)) return false;

    const task: QueueTask<Definitions, Type> = {
      id: ++this.nextId,
      request,
      status: 'queued',
      ...membership,
    };
    this.conflicts.set(task.id, keys);
    this.order.set(task.id, ++this.nextOrder);
    this.store.setState(({ tasks }) => ({ tasks: [...tasks, task] }));
    this.syncGroups();
    this.drain();
    return true;
  }

  clearFinished(): void {
    const finishedGroups = new Set(
      this.store
        .getState()
        .groups.filter(isFinishedGroup)
        .map((group) => group.id),
    );
    const removable = (task: QueueTask<Definitions>) =>
      isFinishedTask(task) && (task.groupId === undefined || finishedGroups.has(task.groupId));
    for (const task of this.store.getState().tasks) {
      if (removable(task))
        void this.handlers[task.request.type].release?.(task.request.input).catch(() => {
          console.error('Task resource release failed.', { taskId: task.id });
        });
    }
    for (const id of finishedGroups) {
      const record = this.groups.get(id);
      if (record?.hooks.release) void this.invokeHook(id, () => record.hooks.release?.());
      this.groups.delete(id);
      this.groupConflicts.delete(id);
    }
    this.store.setState(({ tasks, groups }) => ({
      tasks: tasks.filter((task) => !removable(task)),
      groups: groups.filter((group) => !finishedGroups.has(group.id)),
    }));
  }

  canRetry(task: QueueTask<Definitions>): boolean {
    return (
      task.status === 'failed' &&
      this.groups.get(task.groupId ?? -1)?.phase !== 'settling' &&
      !this.disposed &&
      (this.handlers[task.request.type].canRetry?.(task.request.input) ?? true) &&
      this.handlers[task.request.type].retry !== undefined
    );
  }

  async retry(id: number): Promise<void> {
    const task = this.store.getState().tasks.find((candidate) => candidate.id === id);
    if (!task || !this.canRetry(task)) return;
    const handler = this.handlers[task.request.type];
    const keys = handler.conflictKeys(task.request.input);
    const group = this.store.getState().groups.find((item) => item.id === task.groupId);
    const record = this.groups.get(task.groupId ?? -1);
    if (
      this.hasConflicts(
        [...keys, ...(record?.phase === 'settled' ? (group?.request.resources ?? []) : [])],
        task.groupId,
      )
    )
      return;
    if (record && group) {
      record.phase = 'active';
      this.groupConflicts.set(group.id, group.request.resources ?? []);
    }
    this.conflicts.set(id, keys);
    this.order.set(id, ++this.nextOrder);
    this.update({ id, request: task.request, status: 'queued', controlRequest: 'cancel' });
    try {
      await handler.retry?.(task.request.input);
      this.update({ id, request: task.request, status: 'queued' });
    } catch (error) {
      this.finish({
        id,
        request: task.request,
        status: 'failed',
        failure: handler.toFailure(error),
      });
    }
    this.drain();
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
    if (this.disposed) return;
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
        const current = this.store.getState().tasks.find((candidate) => candidate.id === id);
        if (current?.status === 'running' && this.executions.get(id) === execution)
          this.updateRunning(current, { controlRequest: undefined });
      }
    } finally {
      this.drain();
    }
  }

  private update(task: QueueTask<Definitions>): void {
    const previous = this.store.getState().tasks.find((item) => item.id === task.id);
    this.store.setState(({ tasks }) => ({
      tasks: tasks.map((previous): QueueTask<Definitions> => {
        if (previous.id !== task.id) return previous;
        if (previous.groupId !== undefined) task.groupId = previous.groupId;
        if (previous.memberKey !== undefined) task.memberKey = previous.memberKey;
        return task;
      }),
    }));
    if (previous?.status !== task.status) this.syncGroups();
  }

  private hasConflicts(keys: readonly string[], ownGroup?: number): boolean {
    return [
      ...this.conflicts.values(),
      ...[...this.groupConflicts]
        .filter(([id]) => id !== ownGroup)
        .map(([, resources]) => resources),
    ].some((pending) => keys.some((key) => pending.includes(key)));
  }

  private syncGroups(): void {
    const state = this.store.getState();
    const settle: number[] = [];
    const groups = state.groups.map((previous) => {
      const record = this.groups.get(previous.id)!;
      const tasks = state.tasks.filter((task) => task.groupId === previous.id);
      let group = summarizeGroup(
        previous.id,
        previous.request,
        tasks,
        record.closed,
        record.phase,
        record.preparation,
      );
      if (record.phase === 'active' && group.sealed && tasks.every(isFinishedTask)) {
        record.phase = 'settling';
        group = summarizeGroup(
          previous.id,
          previous.request,
          tasks,
          record.closed,
          'settling',
          record.preparation,
        );
        settle.push(group.id);
      }
      return group;
    });
    this.store.setState({ groups });
    for (const id of settle) {
      const pending = this.settleGroup(id).finally(() => this.settlements.delete(id));
      this.settlements.set(id, pending);
    }
  }

  private async prepareGroup(id: number, signal: AbortSignal): Promise<void> {
    const record = this.groups.get(id);
    if (!record) return;
    const active = () => !signal.aborted && record.preparation.status === 'running';
    record.preparation = { status: signal.aborted ? 'cancelled' : 'running', issues: [] };
    this.syncGroups();
    try {
      if (!signal.aborted)
        await record.hooks.prepare?.({
          groupId: id,
          signal,
          enqueue: async (request, memberKey) => {
            if (!active()) return false;
            if (memberKey && this.hasGroupMember(id, memberKey)) return true;
            await this.waitForGroupCapacity(id, signal);
            if (!active()) return false;
            return this.enqueue(request, { groupId: id, ...(memberKey ? { memberKey } : {}) });
          },
          reportProgress: (progress) => {
            if (!active()) return;
            record.preparation = { ...record.preparation, progress };
            this.syncGroups();
          },
          reportIssue: (issue) => {
            if (!active()) return;
            record.preparation = {
              ...record.preparation,
              issues: [...record.preparation.issues, issue],
            };
            this.syncGroups();
          },
        });
      record.preparation = {
        ...record.preparation,
        status: signal.aborted ? 'cancelled' : 'completed',
      };
    } catch (error) {
      if (signal.aborted) record.preparation = { ...record.preparation, status: 'cancelled' };
      else {
        let failure: TaskFailure = { code: 'unknown', message: { key: 'tasks:unknownError' } };
        try {
          failure = record.hooks.toFailure?.(error) ?? failure;
        } catch {
          console.error('Task group preparation error mapping failed.', { groupId: id });
        }
        record.preparation = { ...record.preparation, status: 'failed', failure };
        await this.invokeHook(id, () => record.hooks.onPreparationFailure?.(failure));
      }
    } finally {
      record.closed = true;
      this.syncGroups();
    }
  }

  dispose(): Promise<void> {
    this.disposal ??= this.disposeQueue();
    return this.disposal;
  }

  private async disposeQueue(): Promise<void> {
    this.disposed = true;
    await Promise.allSettled([
      this.preparations.dispose(),
      ...this.store
        .getState()
        .tasks.filter((task) => !isFinishedTask(task))
        .map((task) => this.cancel(task.id)),
    ]);
    await Promise.allSettled(this.taskRuns.values());
    await Promise.allSettled(
      this.store
        .getState()
        .tasks.filter((task) => !isFinishedTask(task))
        .map((task) => this.cancel(task.id)),
    );
    await Promise.allSettled(this.settlements.values());
    await Promise.all(
      [...this.store.getState().tasks].map((task) =>
        this.invokeHook(task.id, () =>
          this.handlers[task.request.type].release?.(task.request.input),
        ),
      ),
    );
    await Promise.all(
      [...this.groups].map(([id, record]) => this.invokeHook(id, () => record.hooks.release?.())),
    );
  }

  private async settleGroup(id: number): Promise<void> {
    const record = this.groups.get(id);
    if (!record) return;
    if (record.hooks.onSettled) await this.invokeHook(id, () => record.hooks.onSettled?.());
    record.phase = 'settled';
    this.groupConflicts.delete(id);
    this.syncGroups();
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
    this.conflicts.delete(task.id);
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
        this.running[category]++;
        const execution: Promise<void> = this.execute(task).finally(() => {
          if (this.taskRuns.get(taskId) === execution) this.taskRuns.delete(taskId);
          this.running[category]--;
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
