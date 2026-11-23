import type { Entry, EntryRef } from '@shared/storage';
import type { BrowserErrorCode } from '@shared/storage-browser';

export interface DownloadRequest {
  ref: EntryRef;
  directory: string;
  /** Source-name snapshot; the backend verifies it and uses the provider's actual name. */
  expectedName: string;
  replace: boolean;
  /** Optional known entry snapshot to defer remote stat until execution. */
  entry?: Entry | undefined;
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
  entries: { ref: EntryRef; expectedName: string; entry?: Entry | undefined }[];
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
      error?: unknown;
    };
