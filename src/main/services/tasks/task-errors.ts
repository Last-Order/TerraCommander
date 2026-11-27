import { AccountError } from '@main/accounts/core/errors';
import { normalizeStorageError } from '@main/storage';
import { browserErrorKey, type BrowserErrorCode } from '@shared/storage-browser';
import type { TaskFailure } from '@shared/tasks';
import { DownloadError } from '../downloads/download-paths';
import { DownloadPreferenceError } from '../preferences/download-preferences';

export function toBrowserErrorCode(error: unknown): BrowserErrorCode {
  if (
    error instanceof AccountError ||
    error instanceof DownloadError ||
    error instanceof DownloadPreferenceError
  ) {
    return error.code;
  }
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
          : `errors:${browserErrorKey(code)}`,
    },
  };
}
