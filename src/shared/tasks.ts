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
  memberKey?: string | undefined;
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

export interface DownloadTaskDisplayInput {
  parent: EntryRef;
  entry: Entry;
  directoryPath: string;
  destinationPath: string;
  displayName?: string | undefined;
}

export type StorageTaskRequest =
  | { type: 'rename'; input: RenameTaskRequest }
  | { type: 'delete'; input: DeleteTaskRequest }
  | { type: 'download'; input: DownloadTaskDisplayInput };

export interface StorageTaskGroupRequest {
  kind: 'download';
  input: {
    names: readonly string[];
    sourcePath: string;
    destinationPath: string;
  };
  resources?: readonly string[] | undefined;
}

export type StorageTaskItem = TaskViewItem<StorageTaskRequest>;
export type StorageTaskGroupItem = TaskGroupViewItem<StorageTaskGroupRequest>;

export interface StorageTaskSnapshot {
  tasks: readonly StorageTaskItem[];
  groups: readonly StorageTaskGroupItem[];
}

export type StorageDirectoryChange =
  | { kind: 'renamed'; parent: EntryRef; previous: EntryRef; entry: Entry }
  | { kind: 'removed'; parent: EntryRef; ref: EntryRef }
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

export type PrepareDownloadResponse =
  | { status: 'started' }
  | { status: 'conflict'; confirmationId: string; conflicts?: readonly string[] | undefined };

export interface TasksApi {
  getSnapshot(): Promise<BrowserResult<StorageTaskSnapshot>>;
  enqueueRename(request: RenameTaskRequest): Promise<BrowserResult<boolean>>;
  enqueueDelete(request: DeleteTaskRequest): Promise<BrowserResult<boolean>>;
  prepareDownload(request: PrepareDownloadRequest): Promise<BrowserResult<PrepareDownloadResponse>>;
  confirmDownload(confirmationId: string): Promise<BrowserResult<void>>;
  cancelDownloadConfirmation(confirmationId: string): Promise<BrowserResult<void>>;
  pause(taskId: number): Promise<BrowserResult<void>>;
  resume(taskId: number): Promise<BrowserResult<void>>;
  cancel(taskId: number): Promise<BrowserResult<void>>;
  retry(taskId: number): Promise<BrowserResult<void>>;
  clearFinished(): Promise<BrowserResult<void>>;
  onEvent(listener: (event: StorageTaskEvent) => void): () => void;
}
