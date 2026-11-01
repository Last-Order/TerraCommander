import {
  storageErrorMessages,
  type RetryHint,
  type StorageErrorCode,
  type StorageFailure,
} from '../../../shared/storage/errors';

interface StorageErrorOptions {
  cause?: unknown;
  retryHint?: RetryHint;
  retryAfterMs?: number;
  providerCode?: string;
}

/** Public failures carry stable messages; original provider details remain in the backend cause. */
export class StorageError extends Error {
  readonly code: StorageErrorCode;
  readonly retryHint: RetryHint;
  readonly retryAfterMs: number | undefined;
  readonly providerCode: string | undefined;

  constructor(code: StorageErrorCode, options: StorageErrorOptions = {}) {
    super(storageErrorMessages[code], { cause: options.cause });
    this.name = 'StorageError';
    this.code = code;
    this.retryHint = options.retryHint ?? defaultRetryHint(code);
    this.retryAfterMs =
      Number.isSafeInteger(options.retryAfterMs) && (options.retryAfterMs ?? -1) >= 0
        ? options.retryAfterMs
        : undefined;
    this.providerCode =
      options.providerCode && /^[A-Za-z0-9_.-]{1,80}$/.test(options.providerCode)
        ? options.providerCode
        : undefined;
  }

  toJSON(): StorageFailure {
    return {
      code: this.code,
      message: storageErrorMessages[this.code],
      retryHint: this.retryHint,
      ...(this.retryAfterMs !== undefined ? { retryAfterMs: this.retryAfterMs } : {}),
      ...(this.providerCode ? { providerCode: this.providerCode } : {}),
    };
  }
}

function defaultRetryHint(code: StorageErrorCode): RetryHint {
  if (code === 'RateLimited') {
    return 'safe';
  }
  if (code === 'NetworkError' || code === 'OutcomeUnknown' || code === 'Cancelled') {
    return 'after-reconciliation';
  }
  return 'never';
}

export function normalizeStorageError(error: unknown): StorageError {
  if (error instanceof StorageError) {
    return error;
  }
  if (error instanceof Error && error.name === 'AbortError') {
    return new StorageError('Cancelled', { cause: error });
  }
  // An unexpected response failure can follow a successful write, so blind retries are unsafe.
  return new StorageError('OutcomeUnknown', { cause: error });
}

export function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new StorageError('Cancelled');
  }
}
