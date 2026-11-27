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
import { entryKey, type Entry, type EntryRef, type RemoveOptions } from '@shared/storage';
import type { BrowserErrorCode } from '@shared/storage-browser';
import { defaultTransferConcurrency } from '@shared/tasks';
import type {
  CleanupMoveSourceTaskDisplayInput,
  CopyTaskRequest,
  CreateDirectoryTaskRequest,
  DeleteEntriesRequest,
  DeleteTaskRequest,
  MoveTaskRequest,
  PasteEntriesRequest,
  PasteEntriesResponse,
  RenameTaskRequest,
  StorageDirectoryChange,
  StorageTaskEvent,
  StorageTaskGroupItem,
  StorageTaskGroupRequest,
  StorageTaskItem,
  StorageTaskRequest,
  StorageTaskSnapshot,
  TaskControlAvailability,
  TransferFromLocalDialogRequest,
  TransferFromLocalPathsRequest,
  TransferToLocalDirectoryRequest,
} from '@shared/tasks';
import { DownloadPreferenceError } from '../preferences/download-preferences';
import type { LocalPathBridge } from '../storage/local-path-bridge';
import type { StorageEntryOperations } from '../storage/storage-entry-operations';
import type { TransferService } from '../transfers/transfer-service';
import type {
  PreparedTransferBatch,
  SourceDirectoryCleanupEntry,
  TransferPlanItem,
  TransferWork,
} from '../transfers/transfer-types';
import { prepareBatchGroup } from './batch-discovery';
import { planPaste, prepareCopyGroup, slotConflictKey, type CopyDiscoveryItem } from './copy-paste';
import { projectDirectoryEffects } from './directory-effects';
import { SourceCleanupError, toBrowserErrorCode, toTaskFailure } from './task-errors';
import {
  createCrossSourceTransferConfig,
  createTransferHandler,
  type InternalTransferInput,
} from './transfer-handler';
import {
  queueOwnerId,
  TransferSessionCoordinator,
  type SessionTransferRequest,
} from './transfer-session-coordinator';

interface InternalCleanupMoveSourceInput {
  display: CleanupMoveSourceTaskDisplayInput;
  source:
    | { kind: 'transfer-plan'; planId: string }
    | { kind: 'directories'; directories: SourceDirectoryCleanupEntry[] };
}

type InternalTaskDefinitions = {
  'create-directory': { input: CreateDirectoryTaskRequest; result: Entry };
  rename: { input: RenameTaskRequest; result: Entry };
  delete: { input: DeleteTaskRequest; result: void };
  copy: { input: CopyTaskRequest; result: Entry };
  move: { input: MoveTaskRequest; result: Entry };
  transfer: { input: InternalTransferInput; result: Entry };
  'cleanup-move-source': { input: InternalCleanupMoveSourceInput; result: void };
};

type InternalGroupDefinitions = {
  transfer: { input: Extract<StorageTaskGroupRequest, { kind: 'transfer' }>['input'] };
  delete: { input: Extract<StorageTaskGroupRequest, { kind: 'delete' }>['input'] };
  copy: { input: Extract<StorageTaskGroupRequest, { kind: 'copy' }>['input'] };
  move: { input: Extract<StorageTaskGroupRequest, { kind: 'move' }>['input'] };
};

type TaskCategory = 'operation' | 'transfer';

const fatalTransferDirectoryErrorCodes: ReadonlySet<BrowserErrorCode> = new Set<BrowserErrorCode>([
  'AuthRequired',
  'InsufficientSpace',
  'InvalidDownloadDirectory',
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
  transfer: ({ display }) => ({ type: 'transfer', input: display }),
  'cleanup-move-source': ({ display }) => ({ type: 'cleanup-move-source', input: display }),
};

const groupRequestProjectors: {
  [K in keyof InternalGroupDefinitions]: (
    input: InternalGroupDefinitions[K]['input'],
  ) => Extract<StorageTaskGroupRequest, { kind: K }>;
} = {
  transfer: (input) => ({ kind: 'transfer', input }),
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
  | 'directory'
  | 'inspectTransfer'
  | 'inspectCrossConnectionTransfer'
  | 'spaceCapabilities'
  | 'canonicalEntryKey'
  | 'targetLockKeys'
  | 'renameEntry'
  | 'deleteEntry'
  | 'statEntry'
>;

export interface StorageTaskDependencies {
  operations: StorageTaskOperations;
  transfers: TransferService;
  localPathBridge?: LocalPathBridge | undefined;
}

/** Owns session task scheduling, directory discovery, and snapshot projection. */
export class StorageTaskService {
  private readonly operations: StorageTaskOperations;
  private readonly transfers: TransferService;
  private readonly localPathBridge?: LocalPathBridge | undefined;
  private readonly queue: TaskQueue<
    InternalTaskDefinitions,
    InternalGroupDefinitions,
    TaskCategory
  >;
  private readonly session: TransferSessionCoordinator;
  private readonly listeners = new Set<(event: StorageTaskEvent) => void>();
  private readonly activeCopyNames = new Map<string, Set<string>>();
  private readonly committedCopyTargets = new WeakMap<CopyTaskRequest, Entry>();
  private readonly unsubscribeQueue: () => void;
  private disposal: Promise<void> | undefined;

  constructor(dependencies: StorageTaskDependencies, options: StorageTaskServiceOptions = {}) {
    this.operations = dependencies.operations;
    this.transfers = dependencies.transfers;
    this.localPathBridge = dependencies.localPathBridge;
    const callbacks = {
      emitAuthRequired: (connectionId: string) => {
        this.emit({ type: 'auth-required', connectionId });
      },
      emitDirectoryChanged: (change: StorageDirectoryChange) => {
        this.emitDirectoryChanged(change);
      },
      deleteVerifiedSource: (ref: EntryRef, removeOptions: RemoveOptions, signal?: AbortSignal) =>
        this.operations.deleteEntry(ref, signal ? { signal } : {}, removeOptions),
    };
    this.queue = new TaskQueue<InternalTaskDefinitions, InternalGroupDefinitions, TaskCategory>(
      {
        'create-directory': this.createCreateDirectoryHandler(),
        rename: this.createRenameHandler(),
        delete: this.createDeleteHandler(),
        copy: this.createCopyHandler(),
        move: this.createMoveHandler(),
        transfer: createTransferHandler(
          'transfer',
          createCrossSourceTransferConfig(this.transfers, callbacks),
          callbacks,
        ),
        'cleanup-move-source': this.createCleanupMoveSourceHandler(),
      },
      {
        concurrencyLimits: {
          operation: 16,
          transfer: options.transferConcurrency ?? defaultTransferConcurrency,
        },
      },
    );
    this.session = new TransferSessionCoordinator({
      transfers: this.transfers,
      targetLockKeys: (parent, names) => this.operations.targetLockKeys(parent, names),
      reserveLocks: (locks) => this.queue.reserve(locks),
      releaseReservation: (reservationId) => this.queue.releaseReservation(reservationId),
      enqueueTransfer: (request, work, reservationId) =>
        this.enqueueStandaloneTransfer(request, work, reservationId),
      enqueueTransferGroup: (request, prepared, reservationId) =>
        this.enqueueTransferGroup(request, prepared, reservationId),
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

  async transferFromLocalDialog(
    owner: number,
    request: TransferFromLocalDialogRequest,
    pickPaths: () => Promise<readonly string[]>,
  ): Promise<PasteEntriesResponse> {
    if (!this.localPathBridge) throw new StorageError('Unsupported');
    const result = await this.session.runWithDialogLock(owner, async () => {
      await this.validateLocalTransferTarget(request.targetParent, request.kind === 'directory');
      const paths = await pickPaths();
      if (paths.length === 0) return { status: 'started' } satisfies PasteEntriesResponse;
      return this.transferFromLocalPaths(owner, {
        targetParent: request.targetParent,
        targetDirectoryPath: request.targetDirectoryPath,
        paths,
        ...(request.targetAncestors ? { targetAncestors: request.targetAncestors } : {}),
      });
    });
    return result ?? { status: 'started' };
  }

  async transferFromLocalPaths(
    owner: number,
    request: TransferFromLocalPathsRequest,
  ): Promise<PasteEntriesResponse> {
    if (!this.localPathBridge) throw new StorageError('Unsupported');
    const groups = await this.localPathBridge.resolvePaths(request.paths);
    if (groups.length === 0) return { status: 'started' };
    let lastResponse: PasteEntriesResponse = { status: 'started' };
    for (const group of groups) {
      const response = await this.pasteEntries(owner, {
        mode: 'copy',
        sourceParent: group.parent,
        sourceDirectoryPath: group.parentDisplayPath,
        entries: group.entries,
        targetParent: request.targetParent,
        targetDirectoryPath: request.targetDirectoryPath,
        ...(request.targetAncestors ? { targetAncestors: request.targetAncestors } : {}),
      });
      if (response.status !== 'started') return response;
      lastResponse = response;
    }
    return lastResponse;
  }

  async transferToLocalDirectory(
    owner: number,
    request: TransferToLocalDirectoryRequest,
  ): Promise<PasteEntriesResponse> {
    if (!this.localPathBridge) throw new StorageError('Unsupported');
    let resolved: Awaited<ReturnType<LocalPathBridge['resolveDirectory']>>;
    try {
      resolved = await this.localPathBridge.resolveDirectory(request.directory);
    } catch (error) {
      const code = toBrowserErrorCode(error);
      if (code === 'InvalidArgument' || code === 'NotFound' || code === 'PermissionDenied') {
        throw new DownloadPreferenceError('InvalidDownloadDirectory');
      }
      throw error;
    }
    return this.pasteEntries(owner, {
      mode: 'copy',
      sourceParent: request.sourceParent,
      sourceDirectoryPath: request.sourceDirectoryPath,
      entries: request.entries,
      targetParent: resolved.ref,
      targetDirectoryPath: resolved.canonicalPath,
    });
  }

  async pasteEntries(owner: number, request: PasteEntriesRequest): Promise<PasteEntriesResponse> {
    const plan = await planPaste(this.operations, request);
    if (plan.kind === 'empty') return { status: 'started' };
    if (plan.kind === 'rejected') return { status: 'rejected', reason: plan.reason };
    if (plan.kind === 'transfer') {
      return this.session.prepareTransfer(owner, {
        mode: plan.mode,
        sourceParent: request.sourceParent,
        sourceDirectoryPath: request.sourceDirectoryPath,
        entries: plan.entries,
        targetParent: request.targetParent,
        targetDirectoryPath: request.targetDirectoryPath,
      });
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
      plan.moveAfterCopy,
    );
  }

  confirmTransfer(owner: number, confirmationId: string): Promise<void> {
    return this.session.confirmTransfer(owner, confirmationId);
  }

  cancelTransferConfirmation(owner: number, confirmationId: string): Promise<void> {
    return this.session.cancelTransferConfirmation(owner, confirmationId);
  }

  cancelOwnerConfirmations(owner: number): void {
    this.session.cancelOwnerConfirmations(owner);
  }

  cancelOwnerOperations(owner: number): void {
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

  private async validateLocalTransferTarget(
    targetParent: EntryRef,
    requireCreateDirectory: boolean,
  ): Promise<void> {
    const [spaceCaps, targetEntry] = await Promise.all([
      this.operations.spaceCapabilities(targetParent),
      this.operations.directory(targetParent).stat(),
    ]);
    if (targetEntry.kind !== 'directory') throw new StorageError('InvalidArgument');
    const targetCaps = { ...spaceCaps, ...targetEntry.capabilities };
    if (targetCaps.write?.support === 'unsupported') {
      throw new StorageError('PermissionDenied');
    }
    if (requireCreateDirectory && targetCaps.createDirectory?.support === 'unsupported') {
      throw new StorageError('Unsupported');
    }
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
    moveAfterCopy?: boolean,
  ): PasteEntriesResponse {
    if (!sameDirectory && items.length === 1 && items[0]!.sourceEntry.kind === 'file') {
      const [item] = items;
      const resources: string[] = [];
      if (moveAfterCopy) {
        resources.push(entryKey(item!.sourceEntry.ref));
      }
      if (!targetSemantics.allowsDuplicateNames) {
        resources.push(
          slotConflictKey(item!.targetParent, item!.targetName, targetSemantics.caseInsensitive),
        );
      }
      const enqueued = this.queue.enqueue({
        type: 'copy',
        input: {
          sourceParent: item!.sourceParent,
          entry: item!.sourceEntry,
          targetParent: item!.targetParent,
          targetName: item!.targetName,
          sourceDirectoryPath: request.sourceDirectoryPath,
          targetDirectoryPath: request.targetDirectoryPath,
          ...(moveAfterCopy ? { removeSourceAfterCopy: true } : {}),
        },
        resources,
      });
      if (!enqueued) throw new StorageError(moveAfterCopy ? 'PreconditionFailed' : 'AlreadyExists');
      return { status: 'started' };
    }

    const targetDirKey = sameDirectory ? entryKey(request.targetParent) : undefined;
    const reservedForGroup: string[] = [];
    const sourceDirectories: SourceDirectoryCleanupEntry[] = [];
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

    const groupId = this.queue.createGroup(
      {
        kind: moveAfterCopy ? 'move' : 'copy',
        input: {
          names: items.map((item) => item.targetName),
          sourcePath: request.sourceDirectoryPath,
          destinationPath: request.targetDirectoryPath,
          entries: entries.map((entry) => entry.ref),
        },
        ...(moveAfterCopy ? { resources: entries.map((entry) => entryKey(entry.ref)) } : {}),
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
              ...(moveAfterCopy
                ? {
                    moveAfterCopy: true,
                    onSourceDirectoryDiscovered: (entry) => {
                      sourceDirectories.push(entry);
                    },
                  }
                : {}),
              canonicalKey: (ref) => this.operations.canonicalEntryKey(ref),
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
        ...(moveAfterCopy
          ? {
              finalize: (context) => {
                if (!this.isReadyForMoveCleanup(context.groupId)) return;
                if (!sourceDirectories.some((entry) => !entry.removed)) return;
                context.enqueue(
                  {
                    type: 'cleanup-move-source',
                    input: {
                      display: {
                        sourceParent: request.sourceParent,
                        sourceDirectoryPath: request.sourceDirectoryPath,
                        targetDirectoryPath: request.targetDirectoryPath,
                        names: entries.map((entry) => entry.name),
                        entries: entries.map((entry) => entry.ref),
                      },
                      source: { kind: 'directories', directories: sourceDirectories },
                    },
                    resources: [],
                  },
                  'cleanup-move-source',
                );
              },
            }
          : {}),
        toFailure: (error) => toTaskFailure(error),
        onPreparationFailure: (failure) => {
          if (failure.code === 'AuthRequired') {
            this.emit({ type: 'auth-required', connectionId: request.targetParent.connectionId });
          }
        },
        onSettled: async () => {
          releaseReservedNames();
        },
      },
    );
    if (groupId === undefined) {
      throw new StorageError(moveAfterCopy ? 'PreconditionFailed' : 'AlreadyExists');
    }
    return { status: 'started' };
  }

  private enqueueStandaloneTransfer(
    request: SessionTransferRequest,
    work: TransferWork,
    reservationId: string,
  ): boolean {
    return this.queue.enqueue(
      {
        type: 'transfer',
        input: {
          display: {
            mode: work.mode,
            sourceProvider: work.sourceProvider,
            targetProvider: work.targetProvider,
            sourceParent: request.sourceParent,
            targetParent: request.targetParent,
            entry: work.item.entry,
            targetName: work.item.targetName,
            sourceDirectoryPath: request.sourceDirectoryPath,
            targetDirectoryPath: request.targetDirectoryPath,
          },
          workRef: work.ref,
        },
      },
      { reservationId },
    );
  }

  private enqueueTransferGroup(
    request: SessionTransferRequest,
    prepared: PreparedTransferBatch,
    reservationId: string,
  ): boolean {
    const groupRequest: TaskGroupRequest<InternalGroupDefinitions> = {
      kind: 'transfer',
      input: {
        mode: prepared.mode,
        sourceProvider: prepared.sourceProvider,
        targetProvider: prepared.targetProvider,
        names: request.entries.map((entry) => entry.name),
        sourcePath: request.sourceDirectoryPath,
        destinationPath: request.targetDirectoryPath,
        sourceEntries: request.entries.map((entry) => entry.ref),
        targetParent: request.targetParent,
      },
    };
    const authConnectionId =
      prepared.sourceProvider !== 'local' && prepared.targetProvider === 'local'
        ? request.sourceParent.connectionId
        : request.targetParent.connectionId;
    const hooks: TaskGroupHooks<InternalTaskDefinitions> = {
      prepare: (context) => this.prepareTransferGroup(request, prepared, context),
      ...(prepared.mode === 'move'
        ? {
            finalize: (context) => {
              if (!this.isReadyForMoveCleanup(context.groupId)) return;
              const remaining = this.transfers.getRemainingSourceDirectories(
                queueOwnerId,
                prepared.id,
              );
              if (remaining.length === 0) return;
              context.enqueue(
                {
                  type: 'cleanup-move-source',
                  input: {
                    display: {
                      sourceParent: request.sourceParent,
                      sourceDirectoryPath: request.sourceDirectoryPath,
                      targetDirectoryPath: request.targetDirectoryPath,
                      names: request.entries.map((entry) => entry.name),
                      entries: request.entries.map((entry) => entry.ref),
                    },
                    source: { kind: 'transfer-plan', planId: prepared.id },
                  },
                  resources: [],
                },
                'cleanup-move-source',
              );
            },
          }
        : {}),
      toFailure: (error) => toTaskFailure(error),
      onPreparationFailure: (failure) => {
        if (failure.code === 'AuthRequired') {
          this.emit({ type: 'auth-required', connectionId: authConnectionId });
        }
      },
      onSettled: async () => {
        this.transfers.finishPlan(queueOwnerId, prepared.id);
      },
      release: () => this.transfers.releasePlan(queueOwnerId, prepared.id),
    };
    return this.queue.createGroup(groupRequest, hooks, { reservationId }) !== undefined;
  }

  private async prepareTransferGroup(
    request: SessionTransferRequest,
    prepared: PreparedTransferBatch,
    context: TaskGroupPreparationContext<InternalTaskDefinitions>,
  ): Promise<void> {
    const { allowsDuplicateNames, caseInsensitive } = await this.resolveSpaceSemantics(
      request.targetParent,
    );
    if (context.signal.aborted) return;
    return prepareBatchGroup<TransferPlanItem, InternalTaskDefinitions>(
      {
        initialItems: prepared.items,
        getItemId: (item) => item.id,
        getItemLabel: (item) => item.relativePath,
        isDirectory: (item) => item.entry.kind === 'directory',
        discoverDirectory: (itemId, offset) =>
          this.transfers.discoverDirectory(queueOwnerId, prepared.id, itemId, offset),
        cancelDirectoryItem: (itemId) =>
          this.transfers.cancelPlanItem(queueOwnerId, prepared.id, itemId),
        cancelErrorMessage: 'Transfer directory preparation cancellation failed.',
        fatalErrorCodes: fatalTransferDirectoryErrorCodes,
        beforeDirectory: (item, prepContext) => {
          if (!item.code) return true;
          prepContext.reportIssue({
            label: item.relativePath,
            failure: toTaskFailure(new StorageError(item.code)),
          });
          return false;
        },
        enqueueFile: async (item, prepContext) => {
          if (item.code) {
            prepContext.reportIssue({
              label: item.relativePath,
              failure: toTaskFailure(new StorageError(item.code)),
            });
            return false;
          }
          const resources = allowsDuplicateNames
            ? [entryKey(item.entry.ref)]
            : [
                entryKey(item.entry.ref),
                slotConflictKey(item.targetParent, item.targetName, caseInsensitive),
              ];
          const admitted = await prepContext.enqueue(
            {
              type: 'transfer',
              input: {
                display: {
                  mode: prepared.mode,
                  sourceProvider: prepared.sourceProvider,
                  targetProvider: prepared.targetProvider,
                  sourceParent: item.sourceParent,
                  targetParent: item.targetParent,
                  entry: item.entry,
                  targetName: item.targetName,
                  sourceDirectoryPath: request.sourceDirectoryPath,
                  targetDirectoryPath: request.targetDirectoryPath,
                  displayName: item.relativePath,
                },
                workRef: { planId: prepared.id, itemId: item.id },
              },
              resources,
            },
            `${prepared.id}:${item.id}`,
          );
          if (!admitted && !prepContext.signal.aborted) {
            prepContext.reportIssue({
              label: item.relativePath,
              failure: toTaskFailure(new StorageError('PreconditionFailed')),
            });
          }
          return admitted;
        },
      },
      context,
    );
  }

  private isReadyForMoveCleanup(groupId: number): boolean {
    const state = this.queue.store.getState();
    const group = state.groups.find((item) => item.id === groupId);
    if (!group) return false;
    if (group.preparation.status !== 'completed' || group.preparation.issues.length > 0) {
      return false;
    }
    const members = state.tasks.filter(
      (task) => task.groupId === groupId && task.request.type !== 'cleanup-move-source',
    );
    return members.every((task) => task.status === 'completed');
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
      execute: async ({ entry, name }) => ({
        status: 'completed',
        result: await this.operations.renameEntry(entry.ref, name),
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
      execute: async ({ entry }) => {
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
      execute: async (input, context) => {
        let copied = this.committedCopyTargets.get(input);
        if (!copied) {
          copied = await this.operations
            .directory(input.targetParent)
            .copyEntry(input.entry.ref, input.targetName);
          if (input.removeSourceAfterCopy) {
            this.committedCopyTargets.set(input, copied);
            this.emitDirectoryChanged({
              kind: 'added',
              parent: input.targetParent,
              entry: copied,
            });
          }
        }
        if (input.removeSourceAfterCopy) {
          const removeOptions: RemoveOptions = {
            ...(input.entry.revision !== undefined
              ? { expectedRevision: input.entry.revision }
              : {}),
            ...(input.entry.checksums?.[0] !== undefined
              ? { expectedChecksum: input.entry.checksums[0] }
              : {}),
            ...(input.entry.size !== undefined ? { expectedSize: input.entry.size } : {}),
          };
          try {
            await this.operations.deleteEntry(
              input.entry.ref,
              { signal: context.signal },
              removeOptions,
            );
          } catch (error) {
            throw new SourceCleanupError(error);
          }
          this.committedCopyTargets.delete(input);
          this.emitDirectoryChanged({
            kind: 'removed',
            parent: input.sourceParent,
            ref: input.entry.ref,
          });
        }
        return { status: 'completed', result: copied };
      },
      onSuccess: (input, result) => {
        if (!input.removeSourceAfterCopy) {
          this.emitDirectoryChanged({ kind: 'added', parent: input.targetParent, entry: result });
        }
      },
      canRetry: (input) => input.removeSourceAfterCopy === true,
      retry: async () => {},
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
      execute: async ({ entry, targetParent, targetName }) => ({
        status: 'completed',
        result: await this.operations.directory(targetParent).moveEntry(entry.ref, targetName),
      }),
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

  private createCleanupMoveSourceHandler(): TaskHandler<
    InternalCleanupMoveSourceInput,
    void,
    TaskCategory
  > {
    return {
      category: 'operation',
      execute: async (input, context) => {
        const remaining =
          input.source.kind === 'transfer-plan'
            ? this.transfers.getRemainingSourceDirectories(queueOwnerId, input.source.planId)
            : input.source.directories
                .filter((entry) => !entry.removed)
                .toSorted((left, right) => right.depth - left.depth);
        let firstError: unknown;
        for (const dir of remaining) {
          if (context.signal.aborted) return { status: 'cancelled' };
          const removeOptions: RemoveOptions = {
            onlyIfEmpty: true,
            ...(dir.revision !== undefined ? { expectedRevision: dir.revision } : {}),
          };
          try {
            await this.operations.deleteEntry(dir.ref, { signal: context.signal }, removeOptions);
            if (input.source.kind === 'transfer-plan') {
              this.transfers.markSourceDirectoryDeleted(queueOwnerId, input.source.planId, dir.ref);
            } else {
              dir.removed = true;
            }
            this.emitDirectoryChanged({ kind: 'removed', parent: dir.parent, ref: dir.ref });
          } catch (error) {
            if (context.signal.aborted || toBrowserErrorCode(error) === 'Cancelled') {
              return { status: 'cancelled' };
            }
            if (firstError === undefined) firstError = error;
          }
        }
        if (firstError !== undefined) {
          throw new SourceCleanupError(firstError);
        }
        return { status: 'completed', result: undefined };
      },
      canRetry: () => true,
      retry: async () => {},
      toFailure: (error) => toTaskFailure(error),
      onFailure: (input, failure) => {
        if (failure.code === 'AuthRequired') {
          this.emit({
            type: 'auth-required',
            connectionId: input.display.sourceParent.connectionId,
          });
        }
      },
    };
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
