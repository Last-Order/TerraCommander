import type { Entry, EntryRef } from './storage';
import type { BrowserResult } from './storage-browser';

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
      summary?: TaskMessage;
    }
  | {
      kind: 'determinate';
      completed: number;
      total: number;
      unit: 'bytes' | 'items';
      stage?: TaskMessage;
      bytesPerSecond?: number;
      summary?: TaskMessage;
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
  progress?: TaskProgress;
  issues: readonly TaskPreparationIssue[];
  failure?: TaskFailure;
}

export interface TaskViewItem<Request = unknown, Result = unknown> {
  id: number;
  request: Request;
  status: TaskStatus;
  controls: TaskControlAvailability;
  controlRequest?: 'pause' | 'cancel' | undefined;
  progress?: TaskProgress | undefined;
  failure?: TaskFailure | undefined;
  result?: Result | undefined;
  groupId?: number | undefined;
}

export interface TaskGroupViewItem<Request = unknown> {
  id: number;
  request: Request;
  sealed: boolean;
  state: TaskGroupState;
  summary: TaskGroupSummary;
  progress: TaskProgress;
  preparation: TaskGroupPreparation;
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

export interface CopyTaskRequest {
  sourceParent: EntryRef;
  entry: Entry;
  targetParent: EntryRef;
  targetName: string;
  sourceDirectoryPath: string;
  targetDirectoryPath: string;
  displayName?: string | undefined;
}

export interface MoveTaskRequest {
  sourceParent: EntryRef;
  entry: Entry;
  targetParent: EntryRef;
  targetName: string;
  sourceDirectoryPath: string;
  targetDirectoryPath: string;
  displayName?: string | undefined;
}

export interface PasteEntriesRequest {
  mode?: PasteMode | undefined;
  sourceParent: EntryRef;
  sourceDirectoryPath: string;
  entries: readonly Entry[];
  targetParent: EntryRef;
  targetDirectoryPath: string;
}

export interface DownloadTaskDisplayInput {
  parent: EntryRef;
  entry: Entry;
  directoryPath: string;
  destinationPath: string;
  displayName?: string | undefined;
}

export interface UploadFileRequest {
  parent: EntryRef;
  directoryPath: string;
}

export interface UploadPathsRequest extends UploadFileRequest {
  paths: readonly string[];
}

export interface UploadTaskDisplayInput extends UploadFileRequest {
  name: string;
  displayName?: string | undefined;
  sourceEntries?: readonly EntryRef[] | undefined;
}

export type StorageTaskRequest =
  | { type: 'rename'; input: RenameTaskRequest }
  | { type: 'delete'; input: DeleteTaskRequest }
  | { type: 'copy'; input: CopyTaskRequest }
  | { type: 'move'; input: MoveTaskRequest }
  | { type: 'download'; input: DownloadTaskDisplayInput }
  | { type: 'upload'; input: UploadTaskDisplayInput };

export type StorageTaskGroupRequest =
  | {
      kind: 'download';
      input: {
        names: readonly string[];
        sourcePath: string;
        destinationPath: string;
        entries?: readonly EntryRef[] | undefined;
      };
    }
  | {
      kind: 'upload';
      input: {
        names: readonly string[];
        sourcePath: string;
        destinationPath: string;
        sourceEntries?: readonly EntryRef[] | undefined;
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

export interface StorageTaskSnapshot {
  tasks: readonly StorageTaskItem[];
  groups: readonly StorageTaskGroupItem[];
}

export type StorageDirectoryChange =
  | { kind: 'renamed'; parent: EntryRef; previous: EntryRef; entry: Entry }
  | { kind: 'removed'; parent: EntryRef; ref: EntryRef }
  | { kind: 'added'; parent: EntryRef; entry: Entry }
  | { kind: 'invalidate-connection'; connectionId: string };

export type StorageTaskEvent =
  | { type: 'snapshot'; snapshot: StorageTaskSnapshot }
  | { type: 'directory-changed'; change: StorageDirectoryChange }
  | { type: 'auth-required'; connectionId: string };

export interface PrepareDownloadRequest {
  parent: EntryRef;
  entries: readonly Entry[];
  directory: string;
  directoryPath: string;
}

export type ConflictConfirmationResponse =
  | { status: 'started' }
  | { status: 'conflict'; confirmationId: string; conflicts?: readonly string[] | undefined };

export type PrepareDownloadResponse = ConflictConfirmationResponse;
export type PasteEntriesResponse = ConflictConfirmationResponse;

export const defaultTransferConcurrency = 8;
export const minTransferConcurrency = 1;
export const maxTransferConcurrency = 32;

export interface TransferSettings {
  concurrencyLimit: number;
}

export interface TasksApi {
  getSnapshot(): Promise<BrowserResult<StorageTaskSnapshot>>;
  enqueueRename(request: RenameTaskRequest): Promise<BrowserResult<boolean>>;
  enqueueDelete(request: DeleteEntriesRequest): Promise<BrowserResult<boolean>>;
  uploadFile(request: UploadFileRequest): Promise<BrowserResult<void>>;
  uploadFolder(request: UploadFileRequest): Promise<BrowserResult<void>>;
  getPathForFile(file: File): string;
  uploadPaths(request: UploadPathsRequest): Promise<BrowserResult<void>>;
  prepareDownload(request: PrepareDownloadRequest): Promise<BrowserResult<PrepareDownloadResponse>>;
  confirmDownload(confirmationId: string): Promise<BrowserResult<void>>;
  cancelDownloadConfirmation(confirmationId: string): Promise<BrowserResult<void>>;
  pasteEntries(request: PasteEntriesRequest): Promise<BrowserResult<PasteEntriesResponse>>;
  pause(taskId: number): Promise<BrowserResult<void>>;
  resume(taskId: number): Promise<BrowserResult<void>>;
  cancel(taskId: number): Promise<BrowserResult<void>>;
  retry(taskId: number): Promise<BrowserResult<void>>;
  clearFinished(): Promise<BrowserResult<void>>;
  onEvent(listener: (event: StorageTaskEvent) => void): () => void;
}
