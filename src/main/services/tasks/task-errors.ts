import type { EntryRef } from '@shared/storage';
import type { BrowserErrorCode } from '@shared/storage-browser';
import type { TaskFailure } from '@shared/tasks';
import { AccountError } from '@main/accounts/core/errors';
import { normalizeStorageError } from '@main/storage';
import { DownloadError } from '../downloads/download-paths';

export const queueOwnerId = 0;

export function entryKey({ connectionId, spaceId, locator }: EntryRef): string {
  return JSON.stringify([connectionId, spaceId, locator]);
}

export function workKey(ref: { planId: string; itemId: number }): string {
  return `${ref.planId}:${ref.itemId}`;
}

export function toBrowserErrorCode(error: unknown): BrowserErrorCode {
  if (error instanceof AccountError || error instanceof DownloadError) return error.code;
  return normalizeStorageError(error).code;
}

export function toTaskFailure(
  error: unknown,
  options?: { invalidArgumentKey?: string },
): TaskFailure {
  const code = toBrowserErrorCode(error);
  return {
    code,
    message: {
      key:
        code === 'InvalidArgument' && options?.invalidArgumentKey
          ? options.invalidArgumentKey
          : `errors:${code}`,
    },
  };
}

export async function releaseQuietly(action: () => Promise<void>, message: string): Promise<void> {
  try {
    await action();
  } catch {
    console.error(message);
  }
}
