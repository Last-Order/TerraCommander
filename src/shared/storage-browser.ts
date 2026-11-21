import type { AccountErrorCode } from './accounts';
import type { DownloadErrorCode } from './downloads';
import type { EntryPage, EntryRef, Space, StorageErrorCode, StorageLabel } from './storage';

export const localConnectionId = 'local';
export type StorageProvider = 'local' | 'google-drive';

export interface StorageConnectionSummary {
  id: string;
  provider: StorageProvider;
  name: StorageLabel;
  detail?: StorageLabel | undefined;
  needsAuthorization: boolean;
  spaces: Space[];
}

export const emptyLocalConnection: StorageConnectionSummary = {
  id: localConnectionId,
  provider: 'local',
  name: { messageKey: 'thisPc' },
  needsAuthorization: false,
  spaces: [],
};

export interface SpaceChoice {
  space: Space;
  available: boolean;
}

export type BrowserErrorCode = AccountErrorCode | StorageErrorCode | DownloadErrorCode;
export type BrowserErrorKey = Uncapitalize<BrowserErrorCode>;
export type BrowserResult<T> = { ok: true; value: T } | { ok: false; code: BrowserErrorCode };

export function browserErrorKey(code: BrowserErrorCode): BrowserErrorKey {
  return `${code[0]!.toLowerCase()}${code.slice(1)}` as BrowserErrorKey;
}

export interface StorageBrowserApi {
  listConnections(): Promise<BrowserResult<StorageConnectionSummary[]>>;
  listSpaces(connectionId: string, refresh?: boolean): Promise<BrowserResult<SpaceChoice[]>>;
  saveSpaces(connectionId: string, spaceIds: string[]): Promise<BrowserResult<void>>;
  addConnection(
    provider: Exclude<StorageProvider, 'local'>,
  ): Promise<BrowserResult<StorageConnectionSummary>>;
  reauthorize(connectionId: string): Promise<BrowserResult<void>>;
  cancelAuthorization(): Promise<BrowserResult<void>>;
  listDirectory(parent: EntryRef, cursor?: string): Promise<BrowserResult<EntryPage>>;
  measureDirectorySize(id: string, folders: EntryRef[]): Promise<BrowserResult<number | null>>;
  cancelDirectoryMeasurement(id: string): Promise<BrowserResult<void>>;
}
