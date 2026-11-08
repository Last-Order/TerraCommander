import type { BrowserErrorCode, BrowserResult } from '../../../shared/storage-browser';

export type StorageErrorKey = BrowserErrorCode | 'unknown';

export class StorageBrowserError extends Error {
  constructor(readonly code: BrowserErrorCode) {
    super(code);
  }
}

export async function resultOf<T>(request: Promise<BrowserResult<T>>): Promise<T> {
  const result = await request;
  if (!result.ok) throw new StorageBrowserError(result.code);
  return result.value;
}

export function errorKey(error: unknown): StorageErrorKey {
  return error instanceof StorageBrowserError ? error.code : 'unknown';
}
