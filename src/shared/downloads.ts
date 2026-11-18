import type { BrowserErrorCode, BrowserResult } from './storage-browser';
import type { Entry, EntryRef } from './storage';

export type DownloadErrorCode =
  | 'InvalidDownloadDirectory'
  | 'InvalidDownloadName'
  | 'DownloadTargetBusy'
  | 'DownloadCleanupFailed';

export interface DownloadSettings {
  directory: string;
}

export interface DownloadRequest {
  ref: EntryRef;
  directory: string;
  /** Source-name snapshot; the backend verifies it and uses the provider's actual name. */
  expectedName: string;
  replace: boolean;
}

export interface DownloadExecution {
  id: string;
  path: string;
}

export interface DownloadWorkRef {
  planId: string;
  itemId: number;
}

export interface DownloadWork {
  ref: DownloadWorkRef;
  path: string;
}

export interface DownloadBatchRequest {
  entries: { ref: EntryRef; expectedName: string }[];
  directory: string;
}

export interface PreparedDownloadBatch {
  id: string;
  path: string;
  conflicts: string[];
  items: DownloadPlanItem[];
}

export interface DownloadPlanItem {
  id: number;
  path: string;
  targetPath: string;
  entry: Entry;
  parent?: EntryRef;
  code?: BrowserErrorCode;
}

export interface DownloadPlanPage {
  items: DownloadPlanItem[];
  nextOffset?: number;
}

export interface DownloadProgress {
  id: string;
  attempt: string;
  controls: {
    cancellable: boolean;
    pausable: boolean;
  };
  stage: 'downloading' | 'saving';
  completedBytes: number;
  totalBytes?: number;
  bytesPerSecond?: number;
}

export type DownloadRunResult =
  | { status: 'completed' }
  | {
      status: 'paused';
      completedBytes: number;
      totalBytes?: number;
    };

export interface DownloadsApi {
  getSettings(): Promise<BrowserResult<DownloadSettings>>;
  setDirectory(directory: string): Promise<BrowserResult<DownloadSettings>>;
  chooseDirectory(initialPath: string): Promise<BrowserResult<string | null>>;
  prepare(request: DownloadRequest): Promise<BrowserResult<DownloadWork>>;
  prepareBatch(request: DownloadBatchRequest): Promise<BrowserResult<PreparedDownloadBatch>>;
  confirmBatch(id: string): Promise<BrowserResult<void>>;
  discoverBatchDirectory(
    id: string,
    itemId: number,
    offset: number,
  ): Promise<BrowserResult<DownloadPlanPage>>;
  resolveWork(ref: DownloadWorkRef): Promise<BrowserResult<DownloadExecution>>;
  cancelWork(ref: DownloadWorkRef): Promise<BrowserResult<void>>;
  releaseWork(ref: DownloadWorkRef): Promise<BrowserResult<void>>;
  cancelBatchItem(id: string, itemId: number): Promise<BrowserResult<void>>;
  finishBatch(id: string): Promise<BrowserResult<void>>;
  releaseBatch(id: string): Promise<BrowserResult<void>>;
  run(id: string, attempt: string): Promise<BrowserResult<DownloadRunResult>>;
  pause(id: string): Promise<BrowserResult<void>>;
  cancel(id: string): Promise<BrowserResult<void>>;
  onProgress(listener: (progress: DownloadProgress) => void): () => void;
}
