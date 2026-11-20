import { randomUUID } from 'node:crypto';
import type { Entry } from '@shared/storage';
import { localConnectionId, type BrowserErrorCode } from '@shared/storage-browser';
import type {
  DeleteTaskRequest,
  PrepareDownloadRequest,
  PrepareDownloadResponse,
  RenameTaskRequest,
  StorageDirectoryChange,
  StorageTaskEvent,
  StorageTaskGroupItem,
  StorageTaskGroupRequest,
  StorageTaskItem,
  StorageTaskSnapshot,
  TaskControlAvailability,
  UploadFileRequest,
} from '@shared/tasks';
import { StorageError } from '@main/storage';
import { TaskQueue } from '@main/tasks/task-queue';
import type {
  QueueTask,
  TaskGroup,
  TaskGroupHooks,
  TaskGroupPreparationContext,
  TaskGroupRequest,
  TaskHandler,
} from '@main/tasks/types';
import { DownloadError } from '../downloads/download-paths';
import type {
  DownloadPlanItem,
  DownloadWork,
  PreparedDownloadBatch,
} from '../downloads/download-types';
import type { StorageBrowser } from '../storage/storage-browser';
import type { PreparedUploadBatch, UploadPlanItem, UploadWork } from '../uploads/upload-types';
import { prepareBatchGroup } from './batch-discovery';
import {
  entryKey,
  queueOwnerId,
  releaseQuietly,
  toBrowserErrorCode,
  toTaskFailure,
} from './task-errors';
import {
  createDownloadTransferConfig,
  createTransferHandler,
  createUploadTransferConfig,
  type InternalDownloadInput,
  type InternalUploadInput,
} from './transfer-handler';

type InternalTaskDefinitions = {
  rename: { input: RenameTaskRequest; result: Entry };
  delete: { input: DeleteTaskRequest; result: void };
  download: { input: InternalDownloadInput; result: void };
  upload: { input: InternalUploadInput; result: Entry };
};

type InternalGroupDefinitions = {
  download: { input: Extract<StorageTaskGroupRequest, { kind: 'download' }>['input'] };
  upload: { input: Extract<StorageTaskGroupRequest, { kind: 'upload' }>['input'] };
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

const fatalDirectoryErrorCodes: ReadonlySet<BrowserErrorCode> = new Set<BrowserErrorCode>([
  'AuthRequired',
  'InsufficientSpace',
  'InvalidDownloadDirectory',
]);
const fatalUploadDirectoryErrorCodes: ReadonlySet<BrowserErrorCode> = new Set<BrowserErrorCode>([
  'AuthRequired',
  'PermissionDenied',
  'InsufficientSpace',
]);

/** Owns session task scheduling, directory discovery, and download confirmation state. */
export class StorageTaskService {
  private readonly queue: TaskQueue<
    InternalTaskDefinitions,
    InternalGroupDefinitions,
    TaskCategory
  >;
  private readonly confirmations = new Map<string, PendingConfirmation>();
  private readonly ownerEpochs = new Map<number, number>();
  private readonly uploadPickers = new Set<number>();
  private readonly listeners = new Set<(event: StorageTaskEvent) => void>();
  private readonly unsubscribeQueue: () => void;
  private disposed = false;
  private disposal: Promise<void> | undefined;

  constructor(private readonly browser: StorageBrowser) {
    const callbacks = {
      emitAuthRequired: (connectionId: string) => {
        this.emit({ type: 'auth-required', connectionId });
      },
      emitDirectoryChanged: (change: StorageDirectoryChange) => {
        this.emitDirectoryChanged(change);
      },
    };
    this.queue = new TaskQueue<InternalTaskDefinitions, InternalGroupDefinitions, TaskCategory>(
      {
        rename: this.createRenameHandler(),
        delete: this.createDeleteHandler(),
        download: createTransferHandler(
          'transfer',
          createDownloadTransferConfig(this.browser.downloads, callbacks),
          callbacks,
        ),
        upload: createTransferHandler(
          'transfer',
          createUploadTransferConfig(this.browser.uploads, callbacks),
          callbacks,
        ),
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
      groups: state.groups.map((group) => this.projectGroup(group)),
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

  async uploadFile(
    owner: number,
    request: UploadFileRequest,
    pickFile: () => Promise<string | undefined>,
  ): Promise<void> {
    await this.uploadPaths(owner, request, async () => {
      const path = await pickFile();
      return path ? [path] : [];
    });
  }

  async uploadPaths(
    owner: number,
    request: UploadFileRequest,
    pickPaths: () => Promise<readonly string[]>,
    options?: { requireCreateDirectory?: boolean },
  ): Promise<void> {
    if (this.disposed || this.uploadPickers.has(owner)) return;
    const epoch = this.ownerEpochs.get(owner) ?? 0;
    const active = () => !this.disposed && (this.ownerEpochs.get(owner) ?? 0) === epoch;
    this.uploadPickers.add(owner);
    try {
      await this.browser.uploads.validateDestination(
        request.parent,
        options?.requireCreateDirectory,
      );
      if (!active()) return;
      const paths = await pickPaths();
      if (paths.length === 0 || !active()) return;
      const selection = await this.browser.uploads.prepareSelection(queueOwnerId, {
        parent: request.parent,
        paths,
        validated: true,
        onDirectoryCreated: (parent, entry) => {
          this.emitDirectoryChanged({ kind: 'added', parent, entry });
        },
      });
      if (!active()) {
        await (selection.kind === 'single'
          ? releaseQuietly(
              () => this.browser.uploads.releaseWork(queueOwnerId, selection.work.ref),
              'Upload work cleanup failed.',
            )
          : releaseQuietly(
              () => this.browser.uploads.releaseBatch(queueOwnerId, selection.prepared.id),
              'Upload batch cleanup failed.',
            ));
        return;
      }
      if (selection.kind === 'single') {
        if (!this.enqueueStandaloneUpload(request, selection.work)) {
          await releaseQuietly(
            () => this.browser.uploads.releaseWork(queueOwnerId, selection.work.ref),
            'Upload work cleanup failed.',
          );
        }
        return;
      }
      if (!this.enqueueUploadGroup(request, selection.prepared)) {
        await releaseQuietly(
          () => this.browser.uploads.releaseBatch(queueOwnerId, selection.prepared.id),
          'Upload batch cleanup failed.',
        );
      }
    } finally {
      this.uploadPickers.delete(owner);
    }
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
        await releaseQuietly(
          () => this.browser.downloads.releaseWork(queueOwnerId, work.ref),
          'Download work cleanup failed.',
        );
        throw new StorageError('Cancelled');
      }
      if (!this.enqueueStandaloneDownload(request, single, work)) {
        await releaseQuietly(
          () => this.browser.downloads.releaseWork(queueOwnerId, work.ref),
          'Download work cleanup failed.',
        );
        throw new DownloadError('DownloadTargetBusy');
      }
      return { status: 'started' };
    }

    const prepared = await this.browser.downloads.prepareBatch(queueOwnerId, {
      entries: request.entries.map((entry) => ({ ref: entry.ref, expectedName: entry.name })),
      directory: request.directory,
    });
    if (this.disposed || (this.ownerEpochs.get(owner) ?? 0) !== epoch) {
      await releaseQuietly(
        () => this.browser.downloads.releaseBatch(queueOwnerId, prepared.id),
        'Download batch cleanup failed.',
      );
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
      await releaseQuietly(
        () => this.browser.downloads.releaseBatch(queueOwnerId, prepared.id),
        'Download batch cleanup failed.',
      );
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
        await releaseQuietly(
          () => this.browser.downloads.releaseWork(queueOwnerId, work.ref),
          'Download work cleanup failed.',
        );
        throw new StorageError('Cancelled');
      }
      if (!this.enqueueStandaloneDownload(confirmation.request, confirmation.entry, work)) {
        await releaseQuietly(
          () => this.browser.downloads.releaseWork(queueOwnerId, work.ref),
          'Download work cleanup failed.',
        );
        throw new DownloadError('DownloadTargetBusy');
      }
      return;
    }

    try {
      this.browser.downloads.confirmBatch(queueOwnerId, confirmation.prepared.id);
    } catch (error) {
      await releaseQuietly(
        () => this.browser.downloads.releaseBatch(queueOwnerId, confirmation.prepared.id),
        'Download batch cleanup failed.',
      );
      throw error;
    }
    if (!this.enqueueDownloadGroup(confirmation.request, confirmation.prepared)) {
      await releaseQuietly(
        () => this.browser.downloads.releaseBatch(queueOwnerId, confirmation.prepared.id),
        'Download batch cleanup failed.',
      );
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
        void releaseQuietly(
          () => this.browser.downloads.releaseBatch(queueOwnerId, confirmation.prepared.id),
          'Download batch cleanup failed.',
        );
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
        pendingBatches.push(
          releaseQuietly(
            () => this.browser.downloads.releaseBatch(queueOwnerId, confirmation.prepared.id),
            'Download batch cleanup failed.',
          ),
        );
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
    return this.createTransferGroup(
      {
        kind: 'download',
        input: {
          names: request.entries.map((entry) => entry.name),
          sourcePath: request.directoryPath,
          destinationPath: prepared.path,
          entries: request.entries.map((entry) => entry.ref),
        },
        resources: request.entries.map((entry) => entryKey(entry.ref)),
      },
      request.parent.connectionId,
      (context) => this.prepareDownloadGroup(request, prepared, context),
      () => this.browser.downloads.finishBatch(queueOwnerId, prepared.id),
      () => this.browser.downloads.releaseBatch(queueOwnerId, prepared.id),
    );
  }

  private prepareDownloadGroup(
    request: PrepareDownloadRequest,
    prepared: PreparedDownloadBatch,
    context: TaskGroupPreparationContext<InternalTaskDefinitions>,
  ): Promise<void> {
    return prepareBatchGroup<DownloadPlanItem, InternalTaskDefinitions>(
      {
        initialItems: prepared.items,
        getItemId: (item) => item.id,
        getItemLabel: (item) => item.path,
        isDirectory: (item) => item.entry.kind === 'directory',
        discoverDirectory: (itemId, offset) =>
          this.browser.downloads.discoverBatchDirectory(queueOwnerId, prepared.id, itemId, offset),
        cancelDirectoryItem: (itemId) =>
          this.browser.downloads.cancelBatchItem(queueOwnerId, prepared.id, itemId),
        cancelErrorMessage: 'Download directory preparation cancellation failed.',
        fatalErrorCodes: fatalDirectoryErrorCodes,
        stageKey: 'storage:downloadScanning',
        summaryKey: 'storage:downloadPreparationProgress',
        enqueueFile: async (item, prepContext) => {
          const admitted = await prepContext.enqueue(
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
          if (!admitted && !prepContext.signal.aborted) {
            prepContext.reportIssue({
              label: item.path,
              failure: toTaskFailure(new DownloadError('DownloadTargetBusy')),
            });
          }
        },
        afterDirectory: () => {
          this.emitDirectoryChanged({
            kind: 'invalidate-connection',
            connectionId: localConnectionId,
          });
        },
      },
      context,
    );
  }

  private enqueueStandaloneUpload(request: UploadFileRequest, work: UploadWork): boolean {
    return this.queue.enqueue({
      type: 'upload',
      input: {
        display: { ...request, name: work.name },
        workRef: work.ref,
      },
    });
  }

  private enqueueUploadGroup(request: UploadFileRequest, prepared: PreparedUploadBatch): boolean {
    return this.createTransferGroup(
      {
        kind: 'upload',
        input: {
          names: prepared.items.map((item) => item.name),
          sourcePath: prepared.sourcePath,
          destinationPath: request.directoryPath,
        },
      },
      request.parent.connectionId,
      (context) => this.prepareUploadGroup(request, prepared, context),
      () => this.browser.uploads.finishBatch(queueOwnerId, prepared.id),
      () => this.browser.uploads.releaseBatch(queueOwnerId, prepared.id),
    );
  }

  private prepareUploadGroup(
    request: UploadFileRequest,
    prepared: PreparedUploadBatch,
    context: TaskGroupPreparationContext<InternalTaskDefinitions>,
  ): Promise<void> {
    return prepareBatchGroup<UploadPlanItem, InternalTaskDefinitions>(
      {
        initialItems: prepared.items,
        getItemId: (item) => item.id,
        getItemLabel: (item) => item.path,
        isDirectory: (item) => item.kind === 'directory',
        discoverDirectory: (itemId, offset) =>
          this.browser.uploads.discoverBatchDirectory(queueOwnerId, prepared.id, itemId, offset),
        cancelDirectoryItem: (itemId) =>
          this.browser.uploads.cancelBatchItem(queueOwnerId, prepared.id, itemId),
        cancelErrorMessage: 'Upload directory preparation cancellation failed.',
        fatalErrorCodes: fatalUploadDirectoryErrorCodes,
        stageKey: 'storage:uploadScanning',
        summaryKey: 'storage:uploadPreparationProgress',
        beforeDirectory: (item, prepContext) => {
          if (!item.code) return true;
          prepContext.reportIssue({
            label: item.path,
            failure: toTaskFailure(new StorageError(item.code)),
          });
          return false;
        },
        enqueueFile: async (item, prepContext) => {
          if (item.code) {
            prepContext.reportIssue({
              label: item.path,
              failure: toTaskFailure(new StorageError(item.code)),
            });
            return false;
          }
          await prepContext.enqueue(
            {
              type: 'upload',
              input: {
                display: {
                  parent: item.parent,
                  directoryPath: request.directoryPath,
                  name: item.name,
                  displayName: item.path,
                },
                workRef: { planId: prepared.id, itemId: item.id },
              },
            },
            `${prepared.id}:${item.id}`,
          );
          return true;
        },
      },
      context,
    );
  }

  private createTransferGroup(
    request: TaskGroupRequest<InternalGroupDefinitions>,
    connectionId: string,
    prepare: (context: TaskGroupPreparationContext<InternalTaskDefinitions>) => Promise<void>,
    onFinish: () => void,
    onRelease: () => Promise<void>,
  ): boolean {
    const hooks: TaskGroupHooks<InternalTaskDefinitions> = {
      prepare,
      toFailure: (error) => toTaskFailure(error),
      onPreparationFailure: (failure) => {
        if (failure.code === 'AuthRequired') {
          this.emit({ type: 'auth-required', connectionId });
        }
      },
      onSettled: async () => {
        onFinish();
      },
      release: onRelease,
    };
    return this.queue.createGroup(request, hooks) !== undefined;
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
      ...(task.status === 'failed' || (task.status === 'paused' && task.failure)
        ? { failure: task.failure }
        : {}),
      ...(task.status === 'completed' ? { result: task.result } : {}),
      ...(task.groupId !== undefined ? { groupId: task.groupId } : {}),
    };
    if (task.request.type === 'download') {
      const { workRef: _workRef, ...displayInput } = task.request.input;
      return { ...common, request: { type: 'download', input: displayInput } };
    }
    if (task.request.type === 'upload') {
      return { ...common, request: { type: 'upload', input: task.request.input.display } };
    }
    return { ...common, request: task.request };
  }

  private projectGroup(group: TaskGroup<InternalGroupDefinitions>): StorageTaskGroupItem {
    const request: StorageTaskGroupRequest =
      group.request.kind === 'download'
        ? { kind: 'download', input: group.request.input }
        : { kind: 'upload', input: group.request.input };
    return {
      id: group.id,
      request,
      sealed: group.sealed,
      state: group.state,
      summary: group.summary,
      progress: group.progress,
      preparation: group.preparation,
    };
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
}
