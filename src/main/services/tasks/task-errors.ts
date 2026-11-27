import { AccountError } from '@main/accounts/core/errors';
import { normalizeStorageError } from '@main/storage';
import { browserErrorKey, type BrowserErrorCode } from '@shared/storage-browser';
import type { TaskFailure } from '@shared/tasks';
import { DownloadPreferenceError } from '../preferences/download-preferences';

/** Signals that destination content was verified and committed, but source deletion failed. */
export class SourceCleanupError extends Error {
  readonly code: BrowserErrorCode;

  constructor(readonly causeError: unknown) {
    super('Source cleanup failed after copy.');
    this.code = toBrowserErrorCode(causeError);
  }
}

export function toBrowserErrorCode(error: unknown): BrowserErrorCode {
  if (error instanceof SourceCleanupError) return error.code;
  if (error instanceof AccountError || error instanceof DownloadPreferenceError) return error.code;
  return normalizeStorageError(error).code;
}

export function toTaskFailure(
  error: unknown,
  options?: { invalidArgumentKey?: string },
): TaskFailure {
  if (error instanceof SourceCleanupError) {
    return {
      code: 'SourceCleanupFailed',
      message: { key: 'storage:copiedSourceNotRemoved' },
    };
  }
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
