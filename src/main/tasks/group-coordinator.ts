import { isFinishedGroup, isFinishedTask } from '@shared/task-selectors';
import {
  mergeResourceLocks,
  normalizeResourceLocks,
  type ResourceLocks,
  type TaskConflictLedger,
} from './conflict-ledger';
import { TaskGroupPreparations } from './group-preparations';
import { summarizeGroup } from './group-summary';
import type {
  QueueTask,
  TaskDefinitions,
  TaskFailure,
  TaskGroup,
  TaskGroupDefinitions,
  TaskGroupHooks,
  TaskGroupOptions,
  TaskGroupPreparation,
  TaskGroupRequest,
  TaskGroupState,
  TaskMembership,
  TaskRequest,
} from './types';

interface GroupRecord<Definitions extends TaskDefinitions> {
  closed: boolean;
  finalized: boolean;
  phase: TaskGroupState['phase'];
  hooks: TaskGroupHooks<Definitions>;
  preparation: TaskGroupPreparation;
  members: Set<string>;
  locks: ResourceLocks;
}

interface GroupCoordinatorDeps<
  Definitions extends TaskDefinitions,
  Groups extends TaskGroupDefinitions,
> {
  conflicts: TaskConflictLedger;
  nextId(): number;
  getTasks(): readonly QueueTask<Definitions>[];
  getGroups(): readonly TaskGroup<Groups>[];
  setGroups(groups: readonly TaskGroup<Groups>[]): void;
  subscribe(listener: () => void): () => void;
  enqueue(
    request: TaskRequest<Definitions>,
    membership: TaskMembership & { allowSealed?: boolean },
  ): boolean;
  invokeHook(id: number, hook: () => void | Promise<void>): Promise<void>;
  isDisposed(): boolean;
}

/** Coordinates group preparation, backpressure, settlement, and resource release. */
export class TaskGroupCoordinator<
  Definitions extends TaskDefinitions,
  Groups extends TaskGroupDefinitions,
> {
  private readonly records = new Map<number, GroupRecord<Definitions>>();
  private readonly preparations = new TaskGroupPreparations();
  private readonly settlements = new Map<number, Promise<void>>();

  constructor(private readonly deps: GroupCoordinatorDeps<Definitions, Groups>) {}

  createGroup(
    request: TaskGroupRequest<Groups>,
    hooks: TaskGroupHooks<Definitions> = {},
    options: TaskGroupOptions = {},
  ): number | undefined {
    if (this.deps.isDisposed()) return undefined;
    const resources = request.resources ?? [];
    const pendingLocks = options.reservationId
      ? this.deps.conflicts.getPendingLocks(options.reservationId)
      : undefined;
    if (options.reservationId && !pendingLocks) return undefined;
    const mergedLocks = pendingLocks
      ? mergeResourceLocks(pendingLocks, resources)
      : normalizeResourceLocks(resources);
    if (
      this.deps.conflicts.hasConflicts(mergedLocks, {
        ignoreReservation: options.reservationId,
      })
    ) {
      return undefined;
    }
    const id = this.deps.nextId();
    if (options.reservationId) {
      if (!this.deps.conflicts.transferPendingToGroup(options.reservationId, id, resources)) {
        return undefined;
      }
    } else {
      this.deps.conflicts.reserveGroup(id, mergedLocks);
    }
    const preparation: TaskGroupPreparation = {
      status: hooks.prepare ? 'queued' : 'completed',
      issues: [],
    };
    this.records.set(id, {
      closed: false,
      finalized: false,
      phase: 'active',
      hooks,
      preparation,
      members: new Set(),
      locks: mergedLocks,
    });
    const group = summarizeGroup(id, request, [], false, 'active', preparation);
    this.deps.setGroups([...this.deps.getGroups(), group]);
    if (hooks.prepare) this.preparations.enqueue((signal) => this.prepareGroup(id, signal));
    return id;
  }

  sealGroup(id: number): void {
    const record = this.records.get(id);
    if (!record) return;
    record.closed = true;
    this.sync();
  }

  hasMember(groupId: number, memberKey: string): boolean {
    return this.records.get(groupId)?.members.has(memberKey) ?? false;
  }

  registerMember(groupId: number, memberKey: string | undefined): void {
    if (memberKey) this.records.get(groupId)?.members.add(memberKey);
  }

  waitForCapacity(groupId: number, signal: AbortSignal, limit = 64): Promise<void> {
    const available = () =>
      this.deps.getTasks().filter((task) => task.groupId === groupId && !isFinishedTask(task))
        .length < limit;
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
      const unsubscribe = this.deps.subscribe(() => {
        if (available()) {
          cleanup();
          resolve();
        }
      });
      signal.addEventListener('abort', abort, { once: true });
    });
  }

  canRetryMember(groupId: number | undefined): boolean {
    if (groupId === undefined) return true;
    return this.records.get(groupId)?.phase !== 'settling';
  }

  extraRetryConflicts(groupId: number | undefined): ResourceLocks {
    if (groupId === undefined) return [];
    const record = this.records.get(groupId);
    if (record?.phase !== 'settled') return [];
    return record.locks;
  }

  reopenForRetry(groupId: number | undefined): void {
    if (groupId === undefined) return;
    const record = this.records.get(groupId);
    const group = this.deps.getGroups().find((item) => item.id === groupId);
    if (!record || !group) return;
    record.phase = 'active';
    record.finalized = false;
    this.deps.conflicts.reserveGroup(group.id, record.locks);
  }

  hasReleaseHook(groupId: number): boolean {
    return this.records.get(groupId)?.hooks.release !== undefined;
  }

  clearFinished(): { finishedGroupIds: Set<number> } {
    const finishedGroupIds = new Set(
      this.deps
        .getGroups()
        .filter(isFinishedGroup)
        .map((group) => group.id),
    );
    for (const id of finishedGroupIds) {
      const record = this.records.get(id);
      if (record?.hooks.release) void this.deps.invokeHook(id, () => record.hooks.release?.());
      this.records.delete(id);
      this.deps.conflicts.releaseGroup(id);
    }
    return { finishedGroupIds };
  }

  sync(): void {
    const tasksByGroup = this.deps.getTasks();
    const finalizeCandidates: number[] = [];
    const settle: number[] = [];
    const groups = this.deps.getGroups().map((previous) => {
      const record = this.records.get(previous.id)!;
      const tasks = tasksByGroup.filter((task) => task.groupId === previous.id);
      let group = summarizeGroup(
        previous.id,
        previous.request,
        tasks,
        record.closed,
        record.phase,
        record.preparation,
      );
      if (record.phase === 'active' && group.sealed && tasks.every(isFinishedTask)) {
        if (!record.finalized && record.hooks.finalize) {
          record.finalized = true;
          finalizeCandidates.push(group.id);
        } else {
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
      }
      return group;
    });
    this.deps.setGroups(groups);
    for (const id of finalizeCandidates) {
      this.runFinalize(id);
    }
    for (const id of settle) {
      const pending = this.settleGroup(id).finally(() => this.settlements.delete(id));
      this.settlements.set(id, pending);
    }
  }

  private runFinalize(id: number): void {
    const record = this.records.get(id);
    if (!record || !record.hooks.finalize) return;
    let enqueued = false;
    try {
      record.hooks.finalize({
        groupId: id,
        enqueue: (request, memberKey) => {
          const added = this.deps.enqueue(request, {
            groupId: id,
            ...(memberKey !== undefined ? { memberKey } : {}),
            allowSealed: true,
          });
          if (added) enqueued = true;
          return added;
        },
      });
    } catch {
      console.error('Task group finalize hook failed.', { groupId: id });
    }
    if (!enqueued) {
      this.sync();
    }
  }

  disposePreparations(): Promise<void> {
    return this.preparations.dispose();
  }

  async waitForSettlementsAndRelease(): Promise<void> {
    await Promise.allSettled(this.settlements.values());
    await Promise.all(
      [...this.records].map(([id, record]) =>
        this.deps.invokeHook(id, () => record.hooks.release?.()),
      ),
    );
  }

  private async prepareGroup(id: number, signal: AbortSignal): Promise<void> {
    const record = this.records.get(id);
    if (!record) return;
    const active = () => !signal.aborted && record.preparation.status === 'running';
    record.preparation = { status: signal.aborted ? 'cancelled' : 'running', issues: [] };
    this.sync();
    try {
      if (!signal.aborted) {
        await record.hooks.prepare?.({
          groupId: id,
          signal,
          enqueue: async (request, memberKey) => {
            if (!active()) return false;
            if (memberKey && this.hasMember(id, memberKey)) return true;
            await this.waitForCapacity(id, signal);
            if (!active()) return false;
            return this.deps.enqueue(request, { groupId: id, ...(memberKey ? { memberKey } : {}) });
          },
          reportIssue: (issue) => {
            if (!active()) return;
            record.preparation = {
              ...record.preparation,
              issues: [...record.preparation.issues, issue],
            };
            this.sync();
          },
        });
      }
      record.preparation = {
        ...record.preparation,
        status: signal.aborted ? 'cancelled' : 'completed',
      };
    } catch (error) {
      if (signal.aborted) {
        record.preparation = { ...record.preparation, status: 'cancelled' };
      } else {
        let failure: TaskFailure = { code: 'unknown', message: { key: 'tasks:unknownError' } };
        try {
          failure = record.hooks.toFailure?.(error) ?? failure;
        } catch {
          console.error('Task group preparation error mapping failed.', { groupId: id });
        }
        record.preparation = { ...record.preparation, status: 'failed', failure };
        await this.deps.invokeHook(id, () => record.hooks.onPreparationFailure?.(failure));
      }
    } finally {
      record.closed = true;
      this.sync();
    }
  }

  private async settleGroup(id: number): Promise<void> {
    const record = this.records.get(id);
    if (!record) return;
    if (record.hooks.onSettled) await this.deps.invokeHook(id, () => record.hooks.onSettled?.());
    record.phase = 'settled';
    this.deps.conflicts.releaseGroup(id);
    this.sync();
  }
}
