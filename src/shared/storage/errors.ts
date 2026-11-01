export const storageErrorMessages = {
  InvalidArgument: 'The storage request is invalid.',
  NotFound: 'The storage resource was not found.',
  AlreadyExists: 'The storage resource already exists.',
  PermissionDenied: 'Access to the storage resource was denied.',
  AuthRequired: 'Storage authorization is required.',
  RateLimited: 'The storage service is rate limiting requests.',
  Unsupported: 'The requested storage capability is unavailable.',
  PreconditionFailed: 'The storage operation precondition failed.',
  SourceChanged: 'The upload source has changed.',
  ResumeExpired: 'The upload recovery session has expired.',
  ResumeInvalid: 'The upload recovery state cannot be used safely.',
  Cancelled: 'The storage operation was cancelled.',
  NetworkError: 'The storage service could not be reached.',
  InsufficientSpace: 'The storage destination has insufficient space or quota.',
  OutcomeUnknown: 'The storage operation outcome must be reconciled.',
} as const;

export type StorageErrorCode = keyof typeof storageErrorMessages;
export type RetryHint = 'safe' | 'after-reconciliation' | 'never';

export interface StorageFailure {
  code: StorageErrorCode;
  message: string;
  retryHint: RetryHint;
  retryAfterMs?: number;
  providerCode?: string;
}
