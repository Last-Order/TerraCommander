import { randomUUID } from 'node:crypto';
import type { Entry, EntryRef } from '../../shared/storage';
import { localConnectionId, type BrowserErrorCode } from '../../shared/storage-browser';
import type {
  DeleteTaskRequest,
  DownloadTaskDisplayInput,
  PrepareDownloadRequest,
  PrepareDownloadResponse,
  RenameTaskRequest,
  StorageDirectoryChange,
  StorageTaskEvent,
  StorageTaskGroupRequest,
  StorageTaskItem,
  StorageTaskSnapshot,
  TaskControlAvailability,
  TaskFailure,
} from '../../shared/tasks';
import { AccountError } from '../accounts/core/errors';
import { StorageError, normalizeStorageError } from '../storage';
import { TaskQueue } from '../tasks/task-queue';
import type {
  QueueTask,
  TaskGroupHooks,
  TaskGroupPreparationContext,
  TaskHandler,
} from '../tasks/types';
import { DownloadError } from './download-paths';
import type {
  DownloadExecution,
  DownloadPlanItem,
  DownloadPlanPage,
  DownloadWork,
  DownloadWorkRef,
  PreparedDownloadBatch,
} from './download-types';
import type { StorageBrowser } from './storage-browser';

interface InternalDownloadInput extends DownloadTaskDisplayInput {
  workRef: DownloadWorkRef;
}

type InternalTaskDefinitions = {
  rename: { input: RenameTaskRequest; result: Entry };
  delete: { input: DeleteTaskRequest; result: void };
  download: { input: InternalDownloadInput; result: void };
};

type InternalGroupDefinitions = {
  download: { input: StorageTaskGroupRequest['input'] };
};

type TaskCategory = 'operation' | 'transfer';

type PendingConfirmation =
  | { kind: 'single'; owner: number; request: PrepareDownloadRequest; entry: Entry }
  | {
      kind: 'batch';
      owner: number;
      request: PrepareDownloadRequest;
      prepared: PreparedDownloadBatch;
    };

const queueOwnerId = 0;

function entryKey({ connectionId, spaceId, locator }: EntryRef): string {
  return JSON.stringify([connectionId, spaceId, locator]);
}

function workKey(ref: DownloadWorkRef): string {
  return `${ref.planId}:${ref.itemId}`;
}

function toBrowserErrorCode(error: unknown): BrowserErrorCode {
  if (error instanceof AccountError || error instanceof DownloadError) return error.code;
  return normalizeStorageError(error).code;
}

function toTaskFailure(error: unknown, options?: { invalidArgumentKey?: string }): TaskFailure {
  const code = toBrowserErrorCode(error);
  return {
    code,
    message: {
      key:
        code === 'InvalidArgument' && options?.invalidArgumentKey
          ? options.invalidArgumentKey
          : `errors:${code}`,
    },
  };
}

/** Owns session task scheduling, directory discovery, and download confirmation state. */
export class StorageTaskService {
  private readonly queue: TaskQueue<
    InternalTaskDefinitions,
    InternalGroupDefinitions,
    TaskCategory
  >;
  private readonly downloadExecutions = new Map<string, DownloadExecution>();
  private readonly confirmations = new Map<string, PendingConfirmation>();
  private readonly ownerEpochs = new Map<number, number>();
  private readonly listeners = new Set<(event: StorageTaskEvent) => void>();
  private readonly unsubscribeQueue: () => void;
  private disposed = false;
  private disposal: Promise<void> | undefined;

  constructor(private readonly browser: StorageBrowser) {
    this.queue = new TaskQueue<InternalTaskDefinitions, InternalGroupDefinitions, TaskCategory>(
      {
        rename: this.createRenameHandler(),
        delete: this.createDeleteHandler(),
        download: this.createDownloadHandler(),
      },
      { concurrencyLimits: { operation: 16, transfer: 8 } },
    );
    this.unsubscribeQueue = this.queue.store.subscribe(() => {
      this.emit({ type: 'snapshot', snapshot: this.getSnapshot() });
    });
  }

  getSnapshot(): StorageTaskSnapshot {
    const state = this.queue.store.getState();
    return {
      tasks: state.tasks.map((task) => this.projectTask(task)),
      groups: state.groups.map((group) => ({ ...group })),
    };
  }

  subscribe(listener: (event: StorageTaskEvent) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  enqueueRename(request: RenameTaskRequest): boolean {
    return this.queue.enqueue({ type: 'rename', input: request });
  }

  enqueueDelete(request: DeleteTaskRequest): boolean {
    return this.queue.enqueue({ type: 'delete', input: request });
  }

  async prepareDownload(
    owner: number,
    request: PrepareDownloadRequest,
  ): Promise<PrepareDownloadResponse> {
    if (this.disposed) throw new StorageError('Cancelled');
    if (request.entries.length === 0) throw new StorageError('InvalidArgument');
    const epoch = this.ownerEpochs.get(owner) ?? 0;
    const single =
      request.entries.length === 1 && request.entries[0]?.kind === 'file'
        ? request.entries[0]
        : undefined;
    if (single) {
      let work: DownloadWork;
      try {
        work = await this.browser.downloads.prepare(queueOwnerId, {
          ref: single.ref,
          directory: request.directory,
          expectedName: single.name,
          replace: false,
        });
      } catch (error) {
        if (
          !this.disposed &&
          (this.ownerEpochs.get(owner) ?? 0) === epoch &&
          toBrowserErrorCode(error) === 'AlreadyExists'
        ) {
          const confirmationId = randomUUID();
          this.confirmations.set(confirmationId, {
            kind: 'single',
            owner,
            request,
            entry: single,
          });
          return { status: 'conflict', confirmationId };
        }
        throw error;
      }
      if (this.disposed || (this.ownerEpochs.get(owner) ?? 0) !== epoch) {
        await this.releaseWorkQuietly(work.ref);
        throw new StorageError('Cancelled');
      }
      if (!this.enqueueStandaloneDownload(request, single, work)) {
        await this.releaseWorkQuietly(work.ref);
        throw new DownloadError('DownloadTargetBusy');
      }
      return { status: 'started' };
    }

    const prepared = await this.browser.downloads.prepareBatch(queueOwnerId, {
      entries: request.entries.map((entry) => ({ ref: entry.ref, expectedName: entry.name })),
      directory: request.directory,
    });
    if (this.disposed || (this.ownerEpochs.get(owner) ?? 0) !== epoch) {
      await this.releaseBatchQuietly(prepared.id);
      throw new StorageError('Cancelled');
    }
    if (prepared.conflicts.length > 0) {
      const confirmationId = randomUUID();
      this.confirmations.set(confirmationId, {
        kind: 'batch',
        owner,
        request,
        prepared,
      });
      return { status: 'conflict', confirmationId, conflicts: prepared.conflicts };
    }
    if (!this.enqueueDownloadGroup(request, prepared)) {
      await this.releaseBatchQuietly(prepared.id);
      throw new DownloadError('DownloadTargetBusy');
    }
    return { status: 'started' };
  }

  async confirmDownload(owner: number, confirmationId: string): Promise<void> {
    if (this.disposed) throw new StorageError('Cancelled');
    const confirmation = this.confirmations.get(confirmationId);
    if (!confirmation || confirmation.owner !== owner) throw new StorageError('InvalidArgument');
    this.confirmations.delete(confirmationId);
    const epoch = this.ownerEpochs.get(owner) ?? 0;

    if (confirmation.kind === 'single') {
      const work = await this.browser.downloads.prepare(queueOwnerId, {
        ref: confirmation.entry.ref,
        directory: confirmation.request.directory,
        expectedName: confirmation.entry.name,
        replace: true,
      });
      if (this.disposed || (this.ownerEpochs.get(owner) ?? 0) !== epoch) {
        await this.releaseWorkQuietly(work.ref);
        throw new StorageError('Cancelled');
      }
      if (!this.enqueueStandaloneDownload(confirmation.request, confirmation.entry, work)) {
        await this.releaseWorkQuietly(work.ref);
        throw new DownloadError('DownloadTargetBusy');
      }
      return;
    }

    try {
      this.browser.downloads.confirmBatch(queueOwnerId, confirmation.prepared.id);
    } catch (error) {
      await this.releaseBatchQuietly(confirmation.prepared.id);
      throw error;
    }
    if (!this.enqueueDownloadGroup(confirmation.request, confirmation.prepared)) {
      await this.releaseBatchQuietly(confirmation.prepared.id);
      throw new DownloadError('DownloadTargetBusy');
    }
  }

  async cancelDownloadConfirmation(owner: number, confirmationId: string): Promise<void> {
    const confirmation = this.confirmations.get(confirmationId);
    if (!confirmation || confirmation.owner !== owner) return;
    this.confirmations.delete(confirmationId);
    if (confirmation.kind === 'batch') {
      await this.browser.downloads.releaseBatch(queueOwnerId, confirmation.prepared.id);
    }
  }

  cancelOwnerConfirmations(owner: number): void {
    this.ownerEpochs.set(owner, (this.ownerEpochs.get(owner) ?? 0) + 1);
    for (const [id, confirmation] of this.confirmations) {
      if (confirmation.owner !== owner) continue;
      this.confirmations.delete(id);
      if (confirmation.kind === 'batch') {
        void this.releaseBatchQuietly(confirmation.prepared.id);
      }
    }
  }

  pause(taskId: number): Promise<void> {
    return this.queue.pause(taskId);
  }

  resume(taskId: number): void {
    this.queue.resume(taskId);
  }

  cancel(taskId: number): Promise<void> {
    return this.queue.cancel(taskId);
  }

  retry(taskId: number): Promise<void> {
    return this.queue.retry(taskId);
  }

  clearFinished(): void {
    this.queue.clearFinished();
  }

  dispose(): Promise<void> {
    this.disposal ??= this.disposeService();
    return this.disposal;
  }

  private async disposeService(): Promise<void> {
    this.disposed = true;
    const pendingBatches: Promise<void>[] = [];
    for (const [id, confirmation] of this.confirmations) {
      this.confirmations.delete(id);
      if (confirmation.kind === 'batch') {
        pendingBatches.push(this.releaseBatchQuietly(confirmation.prepared.id));
      }
    }
    await Promise.allSettled([this.queue.dispose(), ...pendingBatches]);
    this.unsubscribeQueue();
    this.listeners.clear();
  }

  private createRenameHandler(): TaskHandler<RenameTaskRequest, Entry, TaskCategory> {
    return {
      category: 'operation',
      conflictKeys: ({ entry }) => [entryKey(entry.ref)],
      execute: async ({ entry, name }) => ({
        status: 'completed',
        result: await this.browser.renameEntry(entry.ref, name),
      }),
      onSuccess: ({ parent, entry }, result) => {
        this.emitDirectoryChanged({
          kind: 'renamed',
          parent,
          previous: entry.ref,
          entry: result,
        });
      },
      toFailure: (error) =>
        toTaskFailure(error, { invalidArgumentKey: 'storage:invalidEntryName' }),
      onFailure: (input, failure) => {
        if (failure.code === 'AuthRequired') {
          this.emit({ type: 'auth-required', connectionId: input.entry.ref.connectionId });
        }
      },
    };
  }

  private createDeleteHandler(): TaskHandler<DeleteTaskRequest, void, TaskCategory> {
    return {
      category: 'operation',
      conflictKeys: ({ entry }) => [entryKey(entry.ref)],
      execute: async ({ entry }) => {
        await this.browser.deleteEntry(entry.ref);
        return { status: 'completed', result: undefined };
      },
      onSuccess: ({ parent, entry }) => {
        this.emitDirectoryChanged({ kind: 'removed', parent, ref: entry.ref });
      },
      toFailure: (error) => toTaskFailure(error),
      onFailure: (input, failure) => {
        if (failure.code === 'AuthRequired') {
          this.emit({ type: 'auth-required', connectionId: input.entry.ref.connectionId });
        }
      },
    };
  }

  private createDownloadHandler(): TaskHandler<InternalDownloadInput, void, TaskCategory> {
    return {
      category: 'transfer',
      conflictKeys: ({ entry }) => [entryKey(entry.ref)],
      execute: async (
        input,
        context,
      ): Promise<
        Awaited<ReturnType<TaskHandler<InternalDownloadInput, void, TaskCategory>['execute']>>
      > => {
        if (
          input.entry.kind !== 'file' ||
          input.entry.capabilities.read?.support === 'unsupported'
        ) {
          return { status: 'skipped' };
        }
        const executionKey = workKey(input.workRef);
        let paused = false;
        try {
          const execution =
            this.downloadExecutions.get(executionKey) ??
            (await this.browser.downloads.resolveWork(queueOwnerId, input.workRef));
          this.downloadExecutions.set(executionKey, execution);
          if (context.signal.aborted) {
            await this.browser.downloads.cancelWork(queueOwnerId, input.workRef);
            return { status: 'cancelled' };
          }
          const attempt = randomUUID();
          const result = await this.browser.downloads.run(
            queueOwnerId,
            execution.id,
            (progress) => {
              if (progress.id !== execution.id || progress.attempt !== attempt) return;
              const stage = {
                key:
                  progress.stage === 'saving'
                    ? 'storage:downloadSaving'
                    : 'storage:downloadReceiving',
              } as const;
              context.reportControls(progress.controls);
              const rate =
                progress.bytesPerSecond !== undefined
                  ? { bytesPerSecond: progress.bytesPerSecond }
                  : {};
              context.reportProgress(
                progress.totalBytes !== undefined && progress.totalBytes > 0
                  ? {
                      kind: 'determinate',
                      completed: progress.completedBytes,
                      total: progress.totalBytes,
                      unit: 'bytes',
                      stage,
                      ...rate,
                    }
                  : {
                      kind: 'indeterminate',
                      stage,
                      completedBytes: progress.completedBytes,
                      ...rate,
                    },
              );
            },
            attempt,
          );
          if (result.status === 'paused') {
            paused = true;
            context.reportProgress(
              result.totalBytes !== undefined && result.totalBytes > 0
                ? {
                    kind: 'determinate',
                    completed: result.completedBytes,
                    total: result.totalBytes,
                    unit: 'bytes',
                  }
                : { kind: 'indeterminate', completedBytes: result.completedBytes },
            );
            return { status: 'paused' };
          }
          return { status: 'completed', result: undefined };
        } catch (error) {
          if (toBrowserErrorCode(error) === 'Cancelled') return { status: 'cancelled' };
          throw error;
        } finally {
          if (!paused) this.downloadExecutions.delete(executionKey);
          this.emitDirectoryChanged({
            kind: 'invalidate-connection',
            connectionId: localConnectionId,
          });
        }
      },
      cancel: async (input) => {
        try {
          await this.browser.downloads.cancelWork(queueOwnerId, input.workRef);
        } finally {
          this.downloadExecutions.delete(workKey(input.workRef));
        }
      },
      pause: async (input) => {
        const execution = this.downloadExecutions.get(workKey(input.workRef));
        if (execution) await this.browser.downloads.pause(queueOwnerId, execution.id);
      },
      retry: async () => {},
      release: ({ workRef }) => this.browser.downloads.releaseWork(queueOwnerId, workRef),
      toFailure: (error) => toTaskFailure(error),
      onFailure: (input, failure) => {
        if (failure.code === 'AuthRequired') {
          this.emit({ type: 'auth-required', connectionId: input.entry.ref.connectionId });
        }
      },
    };
  }

  private enqueueStandaloneDownload(
    request: PrepareDownloadRequest,
    entry: Entry,
    work: DownloadWork,
  ): boolean {
    return this.queue.enqueue({
      type: 'download',
      input: {
        parent: request.parent,
        entry,
        directoryPath: request.directoryPath,
        destinationPath: work.path,
        workRef: work.ref,
      },
    });
  }

  private enqueueDownloadGroup(
    request: PrepareDownloadRequest,
    prepared: PreparedDownloadBatch,
  ): boolean {
    const hooks: TaskGroupHooks<InternalTaskDefinitions> = {
      prepare: (context) => this.prepareDownloadGroup(request, prepared, context),
      toFailure: (error) => toTaskFailure(error),
      onPreparationFailure: (failure) => {
        if (failure.code === 'AuthRequired') {
          this.emit({ type: 'auth-required', connectionId: request.parent.connectionId });
        }
      },
      onSettled: async () => {
        this.browser.downloads.finishBatch(queueOwnerId, prepared.id);
      },
      release: () => this.browser.downloads.releaseBatch(queueOwnerId, prepared.id),
    };
    return (
      this.queue.createGroup(
        {
          kind: 'download',
          input: {
            names: request.entries.map((entry) => entry.name),
            sourcePath: request.directoryPath,
            destinationPath: prepared.path,
          },
          resources: request.entries.map((entry) => entryKey(entry.ref)),
        },
        hooks,
      ) !== undefined
    );
  }

  private async prepareDownloadGroup(
    request: PrepareDownloadRequest,
    prepared: PreparedDownloadBatch,
    context: TaskGroupPreparationContext<InternalTaskDefinitions>,
  ): Promise<void> {
    const pending = [...prepared.items].reverse();
    let activeDirectory: DownloadPlanItem | undefined;
    let discoveredFiles = 0;
    let preparedFolders = 0;
    const enqueueFile = async (item: DownloadPlanItem) => {
      discoveredFiles++;
      const admitted = await context.enqueue(
        {
          type: 'download',
          input: {
            parent: item.parent ?? request.parent,
            entry: item.entry,
            directoryPath: request.directoryPath,
            destinationPath: item.targetPath,
            displayName: item.path,
            workRef: { planId: prepared.id, itemId: item.id },
          },
        },
        `${prepared.id}:${item.id}`,
      );
      if (!admitted && !context.signal.aborted) {
        context.reportIssue({
          label: item.path,
          failure: toTaskFailure(new DownloadError('DownloadTargetBusy')),
        });
      }
    };
    const cancelDirectory = () => {
      if (!activeDirectory) return;
      void this.browser.downloads
        .cancelBatchItem(queueOwnerId, prepared.id, activeDirectory.id)
        .catch(() => {
          console.error('Download directory preparation cancellation failed.');
        });
    };
    context.signal.addEventListener('abort', cancelDirectory, { once: true });
    try {
      while (pending.length && !context.signal.aborted) {
        const item = pending.pop()!;
        if (item.entry.kind !== 'directory') {
          await enqueueFile(item);
        } else {
          activeDirectory = item;
          try {
            let offset: number | undefined = 0;
            while (offset !== undefined && !context.signal.aborted) {
              const page: DownloadPlanPage = await this.browser.downloads.discoverBatchDirectory(
                queueOwnerId,
                prepared.id,
                item.id,
                offset,
              );
              for (const child of page.items) {
                if (context.signal.aborted) break;
                if (child.entry.kind === 'directory') pending.push(child);
                else await enqueueFile(child);
              }
              offset = page.nextOffset;
            }
            preparedFolders++;
          } catch (error) {
            const code = toBrowserErrorCode(error);
            if (
              context.signal.aborted ||
              code === 'AuthRequired' ||
              code === 'InsufficientSpace' ||
              code === 'InvalidDownloadDirectory'
            ) {
              throw error;
            }
            context.reportIssue({ label: item.path, failure: toTaskFailure(error) });
          } finally {
            activeDirectory = undefined;
            this.emitDirectoryChanged({
              kind: 'invalidate-connection',
              connectionId: localConnectionId,
            });
          }
        }
        context.reportProgress({
          kind: 'indeterminate',
          stage: { key: 'storage:downloadScanning' },
          summary: {
            key: 'storage:downloadPreparationProgress',
            values: { discoveredFiles, preparedFolders },
          },
        });
      }
    } finally {
      context.signal.removeEventListener('abort', cancelDirectory);
    }
  }

  private projectTask(task: QueueTask<InternalTaskDefinitions>): StorageTaskItem {
    const controls: TaskControlAvailability = {
      supportsPause: this.queue.supportsControl(task, 'pause'),
      supportsCancel: this.queue.supportsControl(task, 'cancel'),
      canPause: this.queue.canPause(task),
      canResume: this.queue.canResume(task),
      canCancel: this.queue.canCancel(task),
      canRetry: this.queue.canRetry(task),
    };
    const common = {
      id: task.id,
      status: task.status,
      controls,
      ...(task.controlRequest !== undefined ? { controlRequest: task.controlRequest } : {}),
      ...(task.progress !== undefined ? { progress: task.progress } : {}),
      ...(task.status === 'failed' ? { failure: task.failure } : {}),
      ...(task.status === 'completed' ? { result: task.result } : {}),
      ...(task.groupId !== undefined ? { groupId: task.groupId } : {}),
      ...(task.memberKey !== undefined ? { memberKey: task.memberKey } : {}),
    };
    if (task.request.type === 'download') {
      const { workRef: _workRef, ...displayInput } = task.request.input;
      return { ...common, request: { type: 'download', input: displayInput } };
    }
    return { ...common, request: task.request };
  }

  private emitDirectoryChanged(change: StorageDirectoryChange): void {
    this.emit({ type: 'directory-changed', change });
  }

  private emit(event: StorageTaskEvent): void {
    for (const listener of [...this.listeners]) {
      try {
        listener(event);
      } catch {
        console.error('Task event listener failed.');
      }
    }
  }

  private async releaseWorkQuietly(ref: DownloadWorkRef): Promise<void> {
    try {
      await this.browser.downloads.releaseWork(queueOwnerId, ref);
    } catch {
      console.error('Download work cleanup failed.');
    }
  }

  private async releaseBatchQuietly(id: string): Promise<void> {
    try {
      await this.browser.downloads.releaseBatch(queueOwnerId, id);
    } catch {
      console.error('Download batch cleanup failed.');
    }
  }
}
