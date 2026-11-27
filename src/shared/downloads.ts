import type { BrowserResult } from './storage-browser';

export type DownloadErrorCode = 'InvalidDownloadDirectory';

export interface DownloadSettings {
  directory: string;
}

export interface DownloadsApi {
  chooseDirectory(initialPath: string): Promise<BrowserResult<string | null>>;
}
