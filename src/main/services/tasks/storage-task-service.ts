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
import { entryKey, type Entry } from '@shared/storage';
import { localConnectionId, type BrowserErrorCode } from '@shared/storage-browser';
import { defaultTransferConcurrency } from '@shared/tasks';
import type {
  CopyTaskRequest,
  CreateDirectoryTaskRequest,
  DeleteEntriesRequest,
  DeleteTaskRequest,
  MoveTaskRequest,
  PasteEntriesRequest,
  PasteEntriesResponse,
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
  UploadPathsRequest,
} from '@shared/tasks';
import { DownloadError } from '../downloads/download-paths';
import type { DownloadService } from '../downloads/download-service';
import type {
  DownloadPlanItem,
  DownloadWork,
  PreparedDownloadBatch,
} from '../downloads/download-types';
import type { StorageEntryOperations } from '../storage/storage-entry-operations';
import type { UploadService } from '../uploads/upload-service';
import type { PreparedUploadBatch, UploadPlanItem, UploadWork } from '../uploads/upload-types';
import { prepareBatchGroup } from './batch-discovery';
import {
  planPaste,
  prepareCopyGroup,
  removeMovedSources,
  slotConflictKey,
  type CopyDiscoveryItem,
} from './copy-paste';
import { projectDirectoryEffects } from './directory-effects';
import { toTaskFailure } from './task-errors';
import {
  createDownloadTransferConfig,
  createTransferHandler,
  createUploadTransferConfig,
  type InternalDownloadInput,
  type InternalUploadInput,
} from './transfer-handler';
import {
  queueOwnerId,
  TransferSessionCoordinator,
  type TransferSourceCleanup,
} from './transfer-session-coordinator';

type InternalTaskDefinitions = {
  'create-directory': { input: CreateDirectoryTaskRequest; result: Entry };
  rename: { input: RenameTaskRequest; result: Entry };
  delete: { input: DeleteTaskRequest; result: void };
  copy: { input: CopyTaskRequest; result: Entry };
  move: { input: MoveTaskRequest; result: Entry };
  download: { input: InternalDownloadInput; result: void };
  upload: { input: InternalUploadInput; result: Entry };
};

type InternalGroupDefinitions = {
  download: { input: Extract<StorageTaskGroupRequest, { kind: 'download' }>['input'] };
  upload: { input: Extract<StorageTaskGroupRequest, { kind: 'upload' }>['input'] };
  delete: { input: Extract<StorageTaskGroupRequest, { kind: 'delete' }>['input'] };
  copy: { input: Extract<StorageTaskGroupRequest, { kind: 'copy' }>['input'] };
  move: { input: Extract<StorageTaskGroupRequest, { kind: 'move' }>['input'] };
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
  'create-directory': (input) => ({ type: 'create-directory', input }),
  rename: (input) => ({ type: 'rename', input }),
  delete: (input) => ({ type: 'delete', input }),
  copy: (input) => ({ type: 'copy', input }),
  move: (input) => ({ type: 'move', input }),
  download: ({ workRef: _workRef, removeAfterComplete: _removeAfterComplete, ...input }) => ({
    type: 'download',
    input,
  }),
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
  copy: (input) => ({ kind: 'copy', input }),
  move: (input) => ({ kind: 'move', input }),
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

interface ResolvedSpaceSemantics {
  allowsDuplicateNames: boolean;
  caseInsensitive: boolean;
}

export interface StorageTaskServiceOptions {
  transferConcurrency?: number | undefined;
}

export type StorageTaskOperations = Pick<
  StorageEntryOperations,
  'directory' | 'resolveLocalPath' | 'inspectTransfer' | 'renameEntry' | 'deleteEntry'
>;

export interface StorageTaskDependencies {
  operations: StorageTaskOperations;
  downloads: DownloadService;
  uploads: UploadService;
}

/** Owns session task scheduling, directory discovery, and snapshot projection. */
export class StorageTaskService {
  private readonly operations: StorageTaskOperations;
  private readonly downloads: DownloadService;
  private readonly uploads: UploadService;
  private readonly queue: TaskQueue<
    InternalTaskDefinitions,
    InternalGroupDefinitions,
    TaskCategory
  >;
  private readonly session: TransferSessionCoordinator;
  private readonly listeners = new Set<(event: StorageTaskEvent) => void>();
  private readonly activeCopyNames = new Map<string, Set<string>>();
  private readonly unsubscribeQueue: () => void;
  private disposal: Promise<void> | undefined;

  constructor(dependencies: StorageTaskDependencies, options: StorageTaskServiceOptions = {}) {
    this.operations = dependencies.operations;
    this.downloads = dependencies.downloads;
    this.uploads = dependencies.uploads;
    const callbacks = {
      emitAuthRequired: (connectionId: string) => {
        this.emit({ type: 'auth-required', connectionId });
      },
      emitDirectoryChanged: (change: StorageDirectoryChange) => {
        this.emitDirectoryChanged(change);
      },
      removeMovedSource: ({ parent, entry }: { parent: Entry['ref']; entry: Entry }) =>
        this.removeMovedEntries(parent, [entry]),
    };
    this.queue = new TaskQueue<InternalTaskDefinitions, InternalGroupDefinitions, TaskCategory>(
      {
        'create-directory': this.createCreateDirectoryHandler(),
        rename: this.createRenameHandler(),
        delete: this.createDeleteHandler(),
        copy: this.createCopyHandler(),
        move: this.createMoveHandler(),
        download: createTransferHandler(
          'transfer',
          createDownloadTransferConfig(this.downloads, callbacks),
          callbacks,
        ),
        upload: createTransferHandler(
          'transfer',
          createUploadTransferConfig(this.uploads, callbacks),
          callbacks,
        ),
      },
      {
        concurrencyLimits: {
          operation: 16,
          transfer: options.transferConcurrency ?? defaultTransferConcurrency,
        },
      },
    );
    this.session = new TransferSessionCoordinator({
      downloads: this.downloads,
      uploads: this.uploads,
      enqueueDownload: (request, entry, work, sourceCleanup) =>
        this.enqueueStandaloneDownload(request, entry, work, sourceCleanup),
      enqueueDownloadGroup: (request, prepared, sourceCleanup) =>
        this.enqueueDownloadGroup(request, prepared, sourceCleanup),
      enqueueUpload: (request, work, sourceCleanup) =>
        this.enqueueStandaloneUpload(request, work, sourceCleanup),
      enqueueUploadGroup: (request, prepared, sourceCleanup) =>
        this.enqueueUploadGroup(request, prepared, sourceCleanup),
      emitDirectoryChanged: (change) => this.emitDirectoryChanged(change),
    });
    this.unsubscribeQueue = this.queue.store.subscribe((state, _previous, change) => {
      if (change.kind === 'task-progress') {
        const task = state.tasks.find((item) => item.id === change.taskId);
        if (task?.progress) {
          this.emit({ type: 'task-progress', taskId: task.id, progress: task.progress });
          return;
        }
      }
      this.emit({ type: 'snapshot', snapshot: this.getSnapshot() });
    });
  }

  getSnapshot(): StorageTaskSnapshot {
    const state = this.queue.store.getState();
    return {
      tasks: state.tasks.map((task) => this.projectTask(task)),
      groups: state.groups.map((group) => this.projectGroup(group)),
      directoryEffects: projectDirectoryEffects(state.tasks, state.groups),
    };
  }

  setTransferConcurrency(limit: number): void {
    this.queue.setConcurrencyLimit('transfer', limit);
  }

  subscribe(listener: (event: StorageTaskEvent) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private async resolveSpaceSemantics(ref: Entry['ref']): Promise<ResolvedSpaceSemantics> {
    const semantics = await this.operations.directory(ref).semantics();
    return {
      allowsDuplicateNames: semantics?.allowsDuplicateNames === true,
      caseInsensitive: semantics?.caseSensitive === false,
    };
  }

  async enqueueCreateDirectory(request: CreateDirectoryTaskRequest): Promise<boolean> {
    const { allowsDuplicateNames, caseInsensitive } = await this.resolveSpaceSemantics(
      request.parent,
    );
    return this.queue.enqueue({
      type: 'create-directory',
      input: request,
      resources: allowsDuplicateNames
        ? []
        : [slotConflictKey(request.parent, request.name, caseInsensitive)],
    });
  }

  async enqueueRename(request: RenameTaskRequest): Promise<boolean> {
    const { allowsDuplicateNames, caseInsensitive } = await this.resolveSpaceSemantics(
      request.parent,
    );
    return this.queue.enqueue({
      type: 'rename',
      input: request,
      resources: allowsDuplicateNames
        ? [entryKey(request.entry.ref)]
        : [
            entryKey(request.entry.ref),
            slotConflictKey(request.parent, request.entry.name, caseInsensitive),
            slotConflictKey(request.parent, request.name, caseInsensitive),
          ],
    });
  }

  async enqueueDelete(request: DeleteEntriesRequest): Promise<boolean> {
    const uniqueEntries: Entry[] = [];
    const seen = new Set<string>();
    for (const entry of request.entries) {
      const key = entryKey(entry.ref);
      if (seen.has(key)) continue;
      seen.add(key);
      uniqueEntries.push(entry);
    }
    if (uniqueEntries.length === 0) return false;
    const { allowsDuplicateNames, caseInsensitive } = await this.resolveSpaceSemantics(
      request.parent,
    );
    if (uniqueEntries.length === 1) {
      const [entry] = uniqueEntries;
      return this.queue.enqueue({
        type: 'delete',
        input: {
          parent: request.parent,
          entry: entry!,
          directoryPath: request.directoryPath,
        },
        resources: allowsDuplicateNames
          ? [entryKey(entry!.ref)]
          : [entryKey(entry!.ref), slotConflictKey(request.parent, entry!.name, caseInsensitive)],
      });
    }
    const groupResources = new Set<string>();
    for (const entry of uniqueEntries) {
      groupResources.add(entryKey(entry.ref));
      if (!allowsDuplicateNames) {
        groupResources.add(slotConflictKey(request.parent, entry.name, caseInsensitive));
      }
    }
    const groupId = this.queue.createGroup({
      kind: 'delete',
      input: {
        names: uniqueEntries.map((entry) => entry.name),
        directoryPath: request.directoryPath,
        entries: uniqueEntries.map((entry) => entry.ref),
      },
      resources: [...groupResources],
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
          resources: allowsDuplicateNames
            ? [entryKey(entry.ref)]
            : [entryKey(entry.ref), slotConflictKey(request.parent, entry.name, caseInsensitive)],
        },
        { groupId },
      );
    }
    this.queue.sealGroup(groupId);
    return true;
  }

  uploadPaths(
    owner: number,
    request: UploadFileRequest,
    pickPaths: () => Promise<readonly string[]>,
    options?: { requireCreateDirectory?: boolean },
  ): Promise<void> {
    return this.session.uploadPaths(owner, request, pickPaths, options);
  }

  uploadSelectedPaths(owner: number, request: UploadPathsRequest): Promise<void> {
    return this.session.uploadSelectedPaths(owner, request);
  }

  prepareDownload(
    owner: number,
    request: PrepareDownloadRequest,
  ): Promise<PrepareDownloadResponse> {
    return this.session.prepareDownload(owner, request);
  }

  async pasteEntries(owner: number, request: PasteEntriesRequest): Promise<PasteEntriesResponse> {
    const plan = await planPaste(this.operations, request);
    if (plan.kind === 'empty') return { status: 'started' };
    if (plan.kind === 'rejected') return { status: 'rejected', reason: plan.reason };
    if (plan.kind === 'upload') {
      const sourceCleanup = plan.removeSources
        ? { sourceParent: request.sourceParent, entries: plan.removeSources }
        : undefined;
      await this.session.uploadSelectedPaths(
        owner,
        {
          parent: request.targetParent,
          directoryPath: request.targetDirectoryPath,
          paths: plan.paths,
        },
        sourceCleanup,
      );
      return { status: 'started' };
    }
    if (plan.kind === 'download') {
      const sourceCleanup = plan.removeSources
        ? { sourceParent: request.sourceParent, entries: plan.removeSources }
        : undefined;
      return this.session.prepareDownload(
        owner,
        {
          parent: request.sourceParent,
          entries: plan.entries,
          directory: plan.directory,
          directoryPath: request.sourceDirectoryPath,
        },
        sourceCleanup,
      );
    }
    const targetSemantics = await this.resolveSpaceSemantics(request.targetParent);
    if (plan.kind === 'move') {
      const sourceSemantics =
        request.sourceParent.connectionId === request.targetParent.connectionId &&
        request.sourceParent.spaceId === request.targetParent.spaceId
          ? targetSemantics
          : await this.resolveSpaceSemantics(request.sourceParent);
      return this.enqueueMovePlan(
        request,
        plan.items,
        plan.entries,
        sourceSemantics,
        targetSemantics,
      );
    }
    return this.enqueueCopyPlan(
      request,
      plan.items,
      plan.entries,
      targetSemantics,
      plan.sameDirectory,
      plan.removeSources,
    );
  }

  private enqueueMovePlan(
    request: PasteEntriesRequest,
    items: readonly CopyDiscoveryItem[],
    entries: readonly Entry[],
    sourceSemantics: ResolvedSpaceSemantics,
    targetSemantics: ResolvedSpaceSemantics,
  ): PasteEntriesResponse {
    const moveResources = (item: CopyDiscoveryItem): string[] => {
      const resources = [entryKey(item.sourceEntry.ref)];
      if (!sourceSemantics.allowsDuplicateNames) {
        resources.push(
          slotConflictKey(
            item.sourceParent,
            item.sourceEntry.name,
            sourceSemantics.caseInsensitive,
          ),
        );
      }
      if (!targetSemantics.allowsDuplicateNames) {
        resources.push(
          slotConflictKey(item.targetParent, item.targetName, targetSemantics.caseInsensitive),
        );
      }
      return resources;
    };

    if (items.length === 1) {
      const [item] = items;
      const enqueued = this.queue.enqueue({
        type: 'move',
        input: {
          sourceParent: item!.sourceParent,
          entry: item!.sourceEntry,
          targetParent: item!.targetParent,
          targetName: item!.targetName,
          sourceDirectoryPath: request.sourceDirectoryPath,
          targetDirectoryPath: request.targetDirectoryPath,
        },
        resources: moveResources(item!),
      });
      if (!enqueued) throw new StorageError('PreconditionFailed');
      return { status: 'started' };
    }

    const groupResources = new Set<string>(entries.map((entry) => entryKey(entry.ref)));
    for (const item of items) {
      if (!sourceSemantics.allowsDuplicateNames) {
        groupResources.add(
          slotConflictKey(
            item.sourceParent,
            item.sourceEntry.name,
            sourceSemantics.caseInsensitive,
          ),
        );
      }
      if (!targetSemantics.allowsDuplicateNames) {
        groupResources.add(
          slotConflictKey(item.targetParent, item.targetName, targetSemantics.caseInsensitive),
        );
      }
    }
    const groupId = this.queue.createGroup({
      kind: 'move',
      input: {
        names: items.map((item) => item.targetName),
        sourcePath: request.sourceDirectoryPath,
        destinationPath: request.targetDirectoryPath,
        entries: entries.map((entry) => entry.ref),
      },
      resources: [...groupResources],
    });
    if (groupId === undefined) throw new StorageError('PreconditionFailed');
    for (const item of items) {
      this.queue.enqueue(
        {
          type: 'move',
          input: {
            sourceParent: item.sourceParent,
            entry: item.sourceEntry,
            targetParent: item.targetParent,
            targetName: item.targetName,
            sourceDirectoryPath: request.sourceDirectoryPath,
            targetDirectoryPath: request.targetDirectoryPath,
          },
          resources: moveResources(item),
        },
        { groupId },
      );
    }
    this.queue.sealGroup(groupId);
    return { status: 'started' };
  }

  private enqueueCopyPlan(
    request: PasteEntriesRequest,
    items: readonly CopyDiscoveryItem[],
    entries: readonly Entry[],
    targetSemantics: ResolvedSpaceSemantics,
    sameDirectory?: boolean,
    removeSources?: readonly Entry[],
  ): PasteEntriesResponse {
    if (
      !sameDirectory &&
      !removeSources &&
      items.length === 1 &&
      items[0]!.sourceEntry.kind === 'file'
    ) {
      const [item] = items;
      const enqueued = this.queue.enqueue({
        type: 'copy',
        input: {
          sourceParent: item!.sourceParent,
          entry: item!.sourceEntry,
          targetParent: item!.targetParent,
          targetName: item!.targetName,
          sourceDirectoryPath: request.sourceDirectoryPath,
          targetDirectoryPath: request.targetDirectoryPath,
        },
        resources: targetSemantics.allowsDuplicateNames
          ? []
          : [
              slotConflictKey(
                item!.targetParent,
                item!.targetName,
                targetSemantics.caseInsensitive,
              ),
            ],
      });
      if (!enqueued) throw new StorageError('AlreadyExists');
      return { status: 'started' };
    }

    const targetDirKey = sameDirectory ? entryKey(request.targetParent) : undefined;
    const reservedForGroup: string[] = [];
    const releaseReservedNames = () => {
      if (!targetDirKey || reservedForGroup.length === 0) return;
      const active = this.activeCopyNames.get(targetDirKey);
      if (!active) return;
      for (const name of reservedForGroup) {
        active.delete(name);
      }
      if (active.size === 0) {
        this.activeCopyNames.delete(targetDirKey);
      }
      reservedForGroup.length = 0;
    };

    let groupId: number | undefined;
    groupId = this.queue.createGroup(
      {
        kind: removeSources ? 'move' : 'copy',
        input: {
          names: items.map((item) => item.targetName),
          sourcePath: request.sourceDirectoryPath,
          destinationPath: request.targetDirectoryPath,
          entries: entries.map((entry) => entry.ref),
        },
        ...(removeSources ? { resources: removeSources.map((entry) => entryKey(entry.ref)) } : {}),
      },
      {
        prepare: (context) =>
          prepareCopyGroup(
            {
              sourceDirectory: this.operations.directory(request.sourceParent),
              targetDirectory: this.operations.directory(request.targetParent),
            },
            request,
            items,
            (change) => this.emitDirectoryChanged(change),
            context,
            {
              allowsDuplicateNames: targetSemantics.allowsDuplicateNames,
              caseInsensitive: targetSemantics.caseInsensitive,
              ...(sameDirectory && targetDirKey
                ? {
                    sameDirectory: true,
                    getReservedNames: () => this.activeCopyNames.get(targetDirKey),
                    onReserveName: (normalizedName: string) => {
                      let active = this.activeCopyNames.get(targetDirKey);
                      if (!active) {
                        active = new Set();
                        this.activeCopyNames.set(targetDirKey, active);
                      }
                      active.add(normalizedName);
                      reservedForGroup.push(normalizedName);
                    },
                  }
                : {}),
            },
          ),
        toFailure: (error) => toTaskFailure(error),
        onPreparationFailure: (failure) => {
          if (failure.code === 'AuthRequired') {
            this.emit({ type: 'auth-required', connectionId: request.targetParent.connectionId });
          }
        },
        onSettled: async () => {
          releaseReservedNames();
          if (removeSources && groupId !== undefined && this.isGroupFullyCompleted(groupId)) {
            await this.removeMovedEntries(request.sourceParent, removeSources);
          }
        },
      },
    );
    if (groupId === undefined) {
      throw new StorageError(removeSources ? 'PreconditionFailed' : 'AlreadyExists');
    }
    return { status: 'started' };
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

  cancelOwnerOperations(owner: number): void {
    this.session.cancelOwnerConfirmations(owner);
    this.downloads.cancelOwner(owner);
    this.uploads.cancelOwner(owner);
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

  private createCreateDirectoryHandler(): TaskHandler<
    CreateDirectoryTaskRequest,
    Entry,
    TaskCategory
  > {
    return {
      category: 'operation',
      execute: async ({ parent, name }) => ({
        status: 'completed',
        result: (await this.operations.directory(parent).createDirectory(name)).entry,
      }),
      onSuccess: ({ parent }, result) => {
        this.emitDirectoryChanged({ kind: 'added', parent, entry: result });
      },
      toFailure: (error) =>
        toTaskFailure(error, { invalidArgumentKey: 'storage:invalidEntryName' }),
      onFailure: (input, failure) => {
        if (failure.code === 'AuthRequired') {
          this.emit({ type: 'auth-required', connectionId: input.parent.connectionId });
        }
      },
    };
  }

  private createRenameHandler(): TaskHandler<RenameTaskRequest, Entry, TaskCategory> {
    return {
      category: 'operation',
      execute: async ({ entry, name }) => {
        this.downloads.assertSourceAvailable(entry.ref);
        return {
          status: 'completed',
          result: await this.operations.renameEntry(entry.ref, name),
        };
      },
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
      execute: async ({ entry }) => {
        this.downloads.assertSourceAvailable(entry.ref);
        await this.operations.deleteEntry(entry.ref);
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

  private createCopyHandler(): TaskHandler<CopyTaskRequest, Entry, TaskCategory> {
    return {
      category: 'operation',
      execute: async ({ entry, targetParent, targetName }) => {
        this.downloads.assertSourceAvailable(entry.ref);
        return {
          status: 'completed',
          result: await this.operations.directory(targetParent).copyEntry(entry.ref, targetName),
        };
      },
      onSuccess: ({ targetParent }, result) => {
        this.emitDirectoryChanged({ kind: 'added', parent: targetParent, entry: result });
      },
      toFailure: (error) => toTaskFailure(error),
      onFailure: (input, failure) => {
        if (failure.code === 'AuthRequired') {
          this.emit({ type: 'auth-required', connectionId: input.targetParent.connectionId });
        }
      },
    };
  }

  private createMoveHandler(): TaskHandler<MoveTaskRequest, Entry, TaskCategory> {
    return {
      category: 'operation',
      execute: async ({ entry, targetParent, targetName }) => {
        this.downloads.assertSourceAvailable(entry.ref);
        return {
          status: 'completed',
          result: await this.operations.directory(targetParent).moveEntry(entry.ref, targetName),
        };
      },
      onSuccess: ({ sourceParent, entry, targetParent }, result) => {
        this.emitDirectoryChanged({ kind: 'removed', parent: sourceParent, ref: entry.ref });
        this.emitDirectoryChanged({ kind: 'added', parent: targetParent, entry: result });
      },
      toFailure: (error) => toTaskFailure(error),
      onFailure: (input, failure) => {
        if (failure.code === 'AuthRequired') {
          this.emit({ type: 'auth-required', connectionId: input.targetParent.connectionId });
        }
      },
    };
  }

  private removeMovedEntries(sourceParent: Entry['ref'], entries: readonly Entry[]): Promise<void> {
    return removeMovedSources(
      (ref) => {
        this.downloads.assertSourceAvailable(ref);
        return this.operations.deleteEntry(ref);
      },
      sourceParent,
      entries,
      (change) => this.emitDirectoryChanged(change),
    );
  }

  private isGroupFullyCompleted(groupId: number): boolean {
    const group = this.queue.store.getState().groups.find((item) => item.id === groupId);
    if (!group) return false;
    return (
      group.preparation.status === 'completed' &&
      group.preparation.issues.length === 0 &&
      group.summary.failed === 0 &&
      group.summary.cancelled === 0 &&
      group.summary.skipped === 0
    );
  }

  private enqueueStandaloneDownload(
    request: PrepareDownloadRequest,
    entry: Entry,
    work: DownloadWork,
    sourceCleanup?: TransferSourceCleanup,
  ): boolean {
    const removeAfterComplete =
      sourceCleanup && sourceCleanup.entries.length === 1
        ? { parent: sourceCleanup.sourceParent, entry: sourceCleanup.entries[0]! }
        : undefined;
    return this.queue.enqueue({
      type: 'download',
      input: {
        parent: request.parent,
        entry,
        directoryPath: request.directoryPath,
        destinationPath: work.path,
        workRef: work.ref,
        ...(removeAfterComplete ? { removeAfterComplete } : {}),
      },
    });
  }

  private enqueueDownloadGroup(
    request: PrepareDownloadRequest,
    prepared: PreparedDownloadBatch,
    sourceCleanup?: TransferSourceCleanup,
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
      () => this.downloads.finishBatch(queueOwnerId, prepared.id),
      () => this.downloads.releaseBatch(queueOwnerId, prepared.id),
      sourceCleanup,
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
          this.downloads.discoverBatchDirectory(queueOwnerId, prepared.id, itemId, offset),
        cancelDirectoryItem: (itemId) =>
          this.downloads.cancelBatchItem(queueOwnerId, prepared.id, itemId),
        cancelErrorMessage: 'Download directory preparation cancellation failed.',
        fatalErrorCodes: fatalDirectoryErrorCodes,
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

  private enqueueStandaloneUpload(
    request: UploadFileRequest,
    work: UploadWork,
    sourceCleanup?: TransferSourceCleanup,
  ): boolean {
    const removeAfterComplete =
      sourceCleanup && sourceCleanup.entries.length === 1
        ? { parent: sourceCleanup.sourceParent, entry: sourceCleanup.entries[0]! }
        : undefined;
    return this.queue.enqueue({
      type: 'upload',
      input: {
        display: {
          ...request,
          name: work.name,
          ...(removeAfterComplete ? { sourceEntries: [removeAfterComplete.entry.ref] } : {}),
        },
        workRef: work.ref,
        ...(removeAfterComplete ? { removeAfterComplete } : {}),
      },
    });
  }

  private enqueueUploadGroup(
    request: UploadFileRequest,
    prepared: PreparedUploadBatch,
    sourceCleanup?: TransferSourceCleanup,
  ): boolean {
    return this.createTransferGroup(
      {
        kind: 'upload',
        input: {
          names: prepared.items.map((item) => item.name),
          sourcePath: prepared.sourcePath,
          destinationPath: request.directoryPath,
          ...(sourceCleanup
            ? { sourceEntries: sourceCleanup.entries.map((entry) => entry.ref) }
            : {}),
        },
        ...(sourceCleanup
          ? { resources: sourceCleanup.entries.map((entry) => entryKey(entry.ref)) }
          : {}),
      },
      request.parent.connectionId,
      (context) => this.prepareUploadGroup(request, prepared, context),
      () => this.uploads.finishBatch(queueOwnerId, prepared.id),
      () => this.uploads.releaseBatch(queueOwnerId, prepared.id),
      sourceCleanup,
    );
  }

  private async prepareUploadGroup(
    request: UploadFileRequest,
    prepared: PreparedUploadBatch,
    context: TaskGroupPreparationContext<InternalTaskDefinitions>,
  ): Promise<void> {
    if (prepared.needsValidation) {
      await this.uploads.validateDestination(
        request.parent,
        prepared.needsValidation.requireCreateDirectory,
        context.signal,
      );
      if (context.signal.aborted) return;
    }
    return prepareBatchGroup<UploadPlanItem, InternalTaskDefinitions>(
      {
        initialItems: prepared.items,
        getItemId: (item) => item.id,
        getItemLabel: (item) => item.path,
        isDirectory: (item) => item.kind === 'directory',
        discoverDirectory: (itemId, offset) =>
          this.uploads.discoverBatchDirectory(queueOwnerId, prepared.id, itemId, offset),
        cancelDirectoryItem: (itemId) =>
          this.uploads.cancelBatchItem(queueOwnerId, prepared.id, itemId),
        cancelErrorMessage: 'Upload directory preparation cancellation failed.',
        fatalErrorCodes: fatalUploadDirectoryErrorCodes,
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
    sourceCleanup?: TransferSourceCleanup,
  ): boolean {
    let groupId: number | undefined;
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
        if (sourceCleanup && groupId !== undefined && this.isGroupFullyCompleted(groupId)) {
          await this.removeMovedEntries(sourceCleanup.sourceParent, sourceCleanup.entries);
        }
      },
      release: onRelease,
    };
    groupId = this.queue.createGroup(request, hooks);
    return groupId !== undefined;
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
