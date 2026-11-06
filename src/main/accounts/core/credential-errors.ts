import { StorageError } from '../../storage/core/errors';
import { AccountError } from './errors';

/** Translate account failures only at the boundary consumed by storage adapters. */
export function storageAuthorizationError(error: unknown): StorageError {
  if (error instanceof StorageError) return error;
  if (!(error instanceof AccountError)) return new StorageError('OutcomeUnknown');
  switch (error.code) {
    case 'Cancelled':
      return new StorageError('Cancelled');
    case 'NotFound':
      return new StorageError('NotFound');
    case 'Unsupported':
      return new StorageError('Unsupported');
    case 'RateLimited':
      return new StorageError('RateLimited');
    case 'NetworkError':
    case 'Timeout':
      return new StorageError('NetworkError', { retryHint: 'safe' });
    case 'InsufficientScope':
    case 'AccessBlocked':
    case 'AccessDenied':
      return new StorageError('PermissionDenied');
    default:
      return new StorageError('AuthRequired');
  }
}
