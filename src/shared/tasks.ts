import type { Entry, EntryRef } from './storage';
import type { BrowserResult, StorageProvider } from './storage-browser';

export interface TaskMessage {
  key: string;
  values?: Readonly<Record<string, string | number>>;
}

export interface TaskFailure {
  code: string;
  message: TaskMessage;
}

export type TaskProgress =
  | {
      kind: 'indeterminate';
      stage?: TaskMessage;
      completedBytes?: number;
      bytesPerSecond?: number;
    }
  | {
      kind: 'determinate';
      completed: number;
      total: number;
      unit: 'bytes' | 'items';
      stage?: TaskMessage;
      bytesPerSecond?: number;
    };

export interface TaskControls {
  cancellable: boolean;
  pausable: boolean;
}

export interface TaskControlAvailability {
  supportsPause: boolean;
  supportsCancel: boolean;
  canPause: boolean;
  canResume: boolean;
  canCancel: boolean;
  canRetry: boolean;
}

export type TaskStatus =
  | 'queued'
  | 'running'
  | 'paused'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'skipped';

export type TaskGroupOutcome = 'completed' | 'partial' | 'failed' | 'cancelled';

export type TaskGroupState =
  | { phase: 'active' | 'settling'; outcome?: never }
  | { phase: 'settled'; outcome: TaskGroupOutcome };

export interface TaskGroupSummary {
  total: number;
  queued: number;
  running: number;
  paused: number;
  completed: number;
  failed: number;
  cancelled: number;
  skipped: number;
}

export interface TaskPreparationIssue {
  label: string;
  failure: TaskFailure;
}

export interface TaskGroupPreparation {
  status: 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';
  issues: readonly TaskPreparationIssue[];
  failure?: TaskFailure;
}

export interface TaskViewItem<Request = unknown> {
  id: number;
  request: Request;
  status: TaskStatus;
  controls: TaskControlAvailability;
  controlRequest?: 'pause' | 'cancel' | undefined;
  progress?: TaskProgress | undefined;
  failure?: TaskFailure | undefined;
  groupId?: number | undefined;
}

export interface TaskGroupViewItem<Request = unknown> {
  id: number;
  request: Request;
  sealed: boolean;
  state: TaskGroupState;
  summary: TaskGroupSummary;
  preparation: TaskGroupPreparation;
}

export interface CreateDirectoryTaskRequest {
  parent: EntryRef;
  name: string;
  directoryPath: string;
}

export interface RenameTaskRequest {
  parent: EntryRef;
  entry: Entry;
  name: string;
  directoryPath: string;
}

export interface DeleteTaskRequest {
  parent: EntryRef;
  entry: Entry;
  directoryPath: string;
}

export interface DeleteEntriesRequest {
  parent: EntryRef;
  entries: readonly Entry[];
  directoryPath: string;
}

export type PasteMode = 'copy' | 'cut';

export type PasteRejectionReason = 'self-containment' | 'permission-denied' | 'unsupported';

export interface CopyTaskRequest {
  sourceParent: EntryRef;
  entry: Entry;
  targetParent: EntryRef;
  targetName: string;
  sourceDirectoryPath: string;
  targetDirectoryPath: string;
  displayName?: string | undefined;
  removeSourceAfterCopy?: boolean | undefined;
}

export type MoveTaskRequest = CopyTaskRequest;

export interface PasteEntriesRequest {
  mode?: PasteMode | undefined;
  sourceParent: EntryRef;
  sourceDirectoryPath: string;
  entries: readonly Entry[];
  targetParent: EntryRef;
  targetDirectoryPath: string;
  targetAncestors?: readonly EntryRef[] | undefined;
}

export interface TransferTaskDisplayInput {
  mode: 'copy' | 'move';
  sourceProvider: StorageProvider;
  targetProvider: StorageProvider;
  sourceParent: EntryRef;
  targetParent: EntryRef;
  entry: Entry;
  targetName: string;
  sourceDirectoryPath: string;
  targetDirectoryPath: string;
  displayName?: string | undefined;
}

export interface CleanupMoveSourceTaskDisplayInput {
  sourceParent: EntryRef;
  sourceDirectoryPath: string;
  targetDirectoryPath: string;
  names: readonly string[];
  entries: readonly EntryRef[];
}

export interface TransferFromLocalDialogRequest {
  targetParent: EntryRef;
  targetDirectoryPath: string;
  kind: 'file' | 'directory';
  targetAncestors?: readonly EntryRef[] | undefined;
}

export interface TransferFromLocalPathsRequest {
  targetParent: EntryRef;
  targetDirectoryPath: string;
  paths: readonly string[];
  targetAncestors?: readonly EntryRef[] | undefined;
}

export interface TransferToLocalDirectoryRequest {
  sourceParent: EntryRef;
  sourceDirectoryPath: string;
  entries: readonly Entry[];
  directory: string;
}

export type StorageTaskRequest =
  | { type: 'create-directory'; input: CreateDirectoryTaskRequest }
  | { type: 'rename'; input: RenameTaskRequest }
  | { type: 'delete'; input: DeleteTaskRequest }
  | { type: 'copy'; input: CopyTaskRequest }
  | { type: 'move'; input: MoveTaskRequest }
  | { type: 'transfer'; input: TransferTaskDisplayInput }
  | { type: 'cleanup-move-source'; input: CleanupMoveSourceTaskDisplayInput };

export type StorageTaskGroupRequest =
  | {
      kind: 'transfer';
      input: {
        mode: 'copy' | 'move';
        sourceProvider: StorageProvider;
        targetProvider: StorageProvider;
        names: readonly string[];
        sourcePath: string;
        destinationPath: string;
        sourceEntries: readonly EntryRef[];
        targetParent: EntryRef;
      };
    }
  | {
      kind: 'delete';
      input: {
        names: readonly string[];
        directoryPath: string;
        entries: readonly EntryRef[];
      };
    }
  | {
      kind: 'copy';
      input: {
        names: readonly string[];
        sourcePath: string;
        destinationPath: string;
        entries: readonly EntryRef[];
      };
    }
  | {
      kind: 'move';
      input: {
        names: readonly string[];
        sourcePath: string;
        destinationPath: string;
        entries: readonly EntryRef[];
      };
    };

export type StorageTaskItem = TaskViewItem<StorageTaskRequest>;
export type StorageTaskGroupItem = TaskGroupViewItem<StorageTaskGroupRequest>;

export interface PendingEntryRename {
  parent: EntryRef;
  entry: EntryRef;
  name: string;
}

export interface StorageDirectoryEffects {
  busyEntries: readonly EntryRef[];
  renames: readonly PendingEntryRename[];
}

export interface StorageTaskSnapshot {
  tasks: readonly StorageTaskItem[];
  groups: readonly StorageTaskGroupItem[];
  directoryEffects: StorageDirectoryEffects;
}

export type StorageDirectoryChange =
  | { kind: 'renamed'; parent: EntryRef; previous: EntryRef; entry: Entry }
  | { kind: 'removed'; parent: EntryRef; ref: EntryRef }
  | { kind: 'added'; parent: EntryRef; entry: Entry }
  | { kind: 'invalidate-connection'; connectionId: string };

export type StorageTaskEvent =
  | { type: 'snapshot'; snapshot: StorageTaskSnapshot }
  | { type: 'task-progress'; taskId: number; progress: TaskProgress }
  | { type: 'directory-changed'; change: StorageDirectoryChange }
  | { type: 'auth-required'; connectionId: string };

export type ConflictConfirmationResponse =
  | { status: 'started' }
  | { status: 'conflict'; confirmationId: string; conflicts?: readonly string[] | undefined };

export type PasteEntriesResponse =
  | ConflictConfirmationResponse
  | { status: 'rejected'; reason: PasteRejectionReason };

export const defaultTransferConcurrency = 8;
export const minTransferConcurrency = 1;
export const maxTransferConcurrency = 32;

export interface TransferSettings {
  concurrencyLimit: number;
}

export interface TasksApi {
  getSnapshot(): Promise<BrowserResult<StorageTaskSnapshot>>;
  enqueueCreateDirectory(request: CreateDirectoryTaskRequest): Promise<BrowserResult<boolean>>;
  enqueueRename(request: RenameTaskRequest): Promise<BrowserResult<boolean>>;
  enqueueDelete(request: DeleteEntriesRequest): Promise<BrowserResult<boolean>>;
  getPathForFile(file: File): string;
  transferFromLocalDialog(
    request: TransferFromLocalDialogRequest,
  ): Promise<BrowserResult<PasteEntriesResponse>>;
  transferFromLocalPaths(
    request: TransferFromLocalPathsRequest,
  ): Promise<BrowserResult<PasteEntriesResponse>>;
  transferToLocalDirectory(
    request: TransferToLocalDirectoryRequest,
  ): Promise<BrowserResult<PasteEntriesResponse>>;
  confirmTransfer(confirmationId: string): Promise<BrowserResult<void>>;
  cancelTransferConfirmation(confirmationId: string): Promise<BrowserResult<void>>;
  pasteEntries(request: PasteEntriesRequest): Promise<BrowserResult<PasteEntriesResponse>>;
  pause(taskId: number): Promise<BrowserResult<void>>;
  resume(taskId: number): Promise<BrowserResult<void>>;
  cancel(taskId: number): Promise<BrowserResult<void>>;
  retry(taskId: number): Promise<BrowserResult<void>>;
  clearFinished(): Promise<BrowserResult<void>>;
  onEvent(listener: (event: StorageTaskEvent) => void): () => void;
}
