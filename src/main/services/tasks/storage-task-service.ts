import type { Entry } from '@shared/storage';
import { localConnectionId, type BrowserErrorCode } from '@shared/storage-browser';
import type {
  DeleteEntriesRequest,
  DeleteTaskRequest,
  PrepareDownloadRequest,
  PrepareDownloadResponse,
  RenameTaskRequest,
  StorageDirectoryChange,
  StorageTaskEvent,
  StorageTaskGroupItem,
  StorageTaskGroupRequest,
  StorageTaskItem,
  StorageTaskRequest,
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
import { entryKey, queueOwnerId, toTaskFailure } from './task-errors';
import {
  createDownloadTransferConfig,
  createTransferHandler,
  createUploadTransferConfig,
  type InternalDownloadInput,
  type InternalUploadInput,
} from './transfer-handler';
import { TransferSessionCoordinator } from './transfer-session-coordinator';

type InternalTaskDefinitions = {
  rename: { input: RenameTaskRequest; result: Entry };
  delete: { input: DeleteTaskRequest; result: void };
  download: { input: InternalDownloadInput; result: void };
  upload: { input: InternalUploadInput; result: Entry };
};

type InternalGroupDefinitions = {
  download: { input: Extract<StorageTaskGroupRequest, { kind: 'download' }>['input'] };
  upload: { input: Extract<StorageTaskGroupRequest, { kind: 'upload' }>['input'] };
  delete: { input: Extract<StorageTaskGroupRequest, { kind: 'delete' }>['input'] };
};

type TaskCategory = 'operation' | 'transfer';

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

const taskRequestProjectors: {
  [K in keyof InternalTaskDefinitions]: (
    input: InternalTaskDefinitions[K]['input'],
  ) => Extract<StorageTaskRequest, { type: K }>;
} = {
  rename: (input) => ({ type: 'rename', input }),
  delete: (input) => ({ type: 'delete', input }),
  download: ({ workRef: _workRef, ...input }) => ({ type: 'download', input }),
  upload: ({ display }) => ({ type: 'upload', input: display }),
};

const groupRequestProjectors: {
  [K in keyof InternalGroupDefinitions]: (
    input: InternalGroupDefinitions[K]['input'],
  ) => Extract<StorageTaskGroupRequest, { kind: K }>;
} = {
  download: (input) => ({ kind: 'download', input }),
  upload: (input) => ({ kind: 'upload', input }),
  delete: (input) => ({ kind: 'delete', input }),
};

function projectTaskRequest<K extends keyof InternalTaskDefinitions>(request: {
  type: K;
  input: InternalTaskDefinitions[K]['input'];
}): StorageTaskRequest {
  return taskRequestProjectors[request.type](request.input);
}

function projectGroupRequest<K extends keyof InternalGroupDefinitions>(request: {
  kind: K;
  input: InternalGroupDefinitions[K]['input'];
}): StorageTaskGroupRequest {
  return groupRequestProjectors[request.kind](request.input);
}

/** Owns session task scheduling, directory discovery, and snapshot projection. */
export class StorageTaskService {
  private readonly queue: TaskQueue<
    InternalTaskDefinitions,
    InternalGroupDefinitions,
    TaskCategory
  >;
  private readonly session: TransferSessionCoordinator;
  private readonly listeners = new Set<(event: StorageTaskEvent) => void>();
  private readonly unsubscribeQueue: () => void;
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
    this.session = new TransferSessionCoordinator({
      downloads: this.browser.downloads,
      uploads: this.browser.uploads,
      enqueueDownload: (request, entry, work) =>
        this.enqueueStandaloneDownload(request, entry, work),
      enqueueDownloadGroup: (request, prepared) => this.enqueueDownloadGroup(request, prepared),
      enqueueUpload: (request, work) => this.enqueueStandaloneUpload(request, work),
      enqueueUploadGroup: (request, prepared) => this.enqueueUploadGroup(request, prepared),
      emitDirectoryChanged: (change) => this.emitDirectoryChanged(change),
    });
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

  enqueueDelete(request: DeleteEntriesRequest): boolean {
    const uniqueEntries: Entry[] = [];
    const seen = new Set<string>();
    for (const entry of request.entries) {
      const key = entryKey(entry.ref);
      if (seen.has(key)) continue;
      seen.add(key);
      uniqueEntries.push(entry);
    }
    if (uniqueEntries.length === 0) return false;
    if (uniqueEntries.length === 1) {
      const [entry] = uniqueEntries;
      return this.queue.enqueue({
        type: 'delete',
        input: {
          parent: request.parent,
          entry: entry!,
          directoryPath: request.directoryPath,
        },
      });
    }
    const groupId = this.queue.createGroup({
      kind: 'delete',
      input: {
        names: uniqueEntries.map((entry) => entry.name),
        directoryPath: request.directoryPath,
        entries: uniqueEntries.map((entry) => entry.ref),
      },
      resources: uniqueEntries.map((entry) => entryKey(entry.ref)),
    });
    if (groupId === undefined) return false;
    for (const entry of uniqueEntries) {
      this.queue.enqueue(
        {
          type: 'delete',
          input: {
            parent: request.parent,
            entry,
            directoryPath: request.directoryPath,
          },
        },
        { groupId },
      );
    }
    this.queue.sealGroup(groupId);
    return true;
  }

  uploadFile(
    owner: number,
    request: UploadFileRequest,
    pickFile: () => Promise<string | undefined>,
  ): Promise<void> {
    return this.session.uploadFile(owner, request, pickFile);
  }

  uploadPaths(
    owner: number,
    request: UploadFileRequest,
    pickPaths: () => Promise<readonly string[]>,
    options?: { requireCreateDirectory?: boolean },
  ): Promise<void> {
    return this.session.uploadPaths(owner, request, pickPaths, options);
  }

  prepareDownload(
    owner: number,
    request: PrepareDownloadRequest,
  ): Promise<PrepareDownloadResponse> {
    return this.session.prepareDownload(owner, request);
  }

  confirmDownload(owner: number, confirmationId: string): Promise<void> {
    return this.session.confirmDownload(owner, confirmationId);
  }

  cancelDownloadConfirmation(owner: number, confirmationId: string): Promise<void> {
    return this.session.cancelDownloadConfirmation(owner, confirmationId);
  }

  cancelOwnerConfirmations(owner: number): void {
    this.session.cancelOwnerConfirmations(owner);
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
    const pendingBatches = this.session.dispose();
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
    return {
      id: task.id,
      status: task.status,
      controls,
      request: projectTaskRequest(task.request),
      ...(task.controlRequest !== undefined ? { controlRequest: task.controlRequest } : {}),
      ...(task.progress !== undefined ? { progress: task.progress } : {}),
      ...(task.status === 'failed' || (task.status === 'paused' && task.failure)
        ? { failure: task.failure }
        : {}),
      ...(task.status === 'completed' ? { result: task.result } : {}),
      ...(task.groupId !== undefined ? { groupId: task.groupId } : {}),
    };
  }

  private projectGroup(group: TaskGroup<InternalGroupDefinitions>): StorageTaskGroupItem {
    return {
      id: group.id,
      request: projectGroupRequest(group.request),
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
