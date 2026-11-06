export const accountErrorMessages = {
  InvalidArgument: 'The account request is invalid.',
  NotFound: 'The account no longer exists.',
  Unsupported: 'This account provider or operation is not supported.',
  Busy: 'An account operation is already in progress.',
  BrowserUnavailable: 'The system browser could not be opened.',
  Cancelled: 'The account operation was cancelled.',
  Timeout: 'The account operation timed out.',
  AuthRequired: 'The account authentication needs to be updated.',
  AccessDenied: 'Account authorization was denied.',
  IdentityMismatch: 'The authentication does not match this account.',
  InsufficientScope: 'The required permission was not granted.',
  ClientConfigurationInvalid: 'The provider client is not configured correctly.',
  CredentialStoreUnavailable: 'The account credentials could not be encrypted or decrypted.',
  StoreInvalid: 'The account store is unreadable or has an unsupported format.',
  PersistenceFailed: 'The account changes could not be saved.',
  NetworkError: 'The storage provider could not be reached.',
  RateLimited: 'The storage provider is temporarily limiting requests.',
  ApiDisabled: 'The required provider API is not enabled.',
  AccessBlocked: 'Access is blocked for this account or application.',
  InvalidResponse: 'The provider returned an invalid response.',
} as const;

export type AccountErrorCode = keyof typeof accountErrorMessages;

export interface AccountFailure {
  code: AccountErrorCode;
  message: string;
}
