import { browserErrorKey, type BrowserErrorCode } from '@shared/storage-browser';
import type { TaskFailure } from '@shared/tasks';
import { AccountError } from '@main/accounts/core/errors';
import { normalizeStorageError } from '@main/storage';
import { DownloadError } from '../downloads/download-paths';

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
          : `errors:${browserErrorKey(code)}`,
    },
  };
}
