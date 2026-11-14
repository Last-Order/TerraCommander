import type { BrowserResult } from './storage-browser';
import type { EntryRef } from './storage';

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

export interface PreparedDownload {
  id: string;
  path: string;
}

export interface DownloadProgress {
  id: string;
  stage: 'downloading' | 'saving';
  completedBytes: number;
  totalBytes?: number;
  bytesPerSecond?: number;
}

export interface DownloadsApi {
  getSettings(): Promise<BrowserResult<DownloadSettings>>;
  setDirectory(directory: string): Promise<BrowserResult<DownloadSettings>>;
  chooseDirectory(initialPath: string): Promise<BrowserResult<string | null>>;
  prepare(request: DownloadRequest): Promise<BrowserResult<PreparedDownload>>;
  run(id: string): Promise<BrowserResult<void>>;
  cancel(id: string): Promise<BrowserResult<void>>;
  showInFolder(id: string): Promise<BrowserResult<void>>;
  onProgress(listener: (progress: DownloadProgress) => void): () => void;
}
