import {
  accountErrorMessages,
  type AccountErrorCode,
  type AccountFailure,
} from '../../../shared/accounts';

/** Keep provider bodies, request headers, and private credentials out of public failures. */
export class AccountError extends Error {
  constructor(
    readonly code: AccountErrorCode,
    cause?: unknown,
  ) {
    super(accountErrorMessages[code], { cause });
    this.name = 'AccountError';
  }

  toJSON(): AccountFailure {
    return { code: this.code, message: accountErrorMessages[this.code] };
  }
}

export function assertNotCancelled(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  if (signal.reason instanceof AccountError) throw signal.reason;
  throw new AccountError('Cancelled');
}

export function accountError(error: unknown, signal?: AbortSignal): AccountError {
  assertNotCancelled(signal);
  if (error instanceof AccountError) return error;
  return new AccountError('InvalidResponse', error);
}
