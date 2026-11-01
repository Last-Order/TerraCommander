import { describe, expect, it } from 'vitest';
import { normalizeStorageError, StorageError } from './errors';

describe('public storage failures', () => {
  it('keeps private causes out of serialized failures', () => {
    const cause = new Error('credential=private upload-url=private');
    const failure = normalizeStorageError(cause);
    expect(failure.cause).toBe(cause);
    expect(JSON.stringify(failure)).not.toContain('private');
    expect(failure.toJSON()).toMatchObject({
      code: 'OutcomeUnknown',
      retryHint: 'after-reconciliation',
    });
  });

  it('preserves declared permission errors instead of guessing absence', () => {
    expect(normalizeStorageError(new StorageError('PermissionDenied')).code).toBe(
      'PermissionDenied',
    );
    const abort = new Error();
    abort.name = 'AbortError';
    expect(normalizeStorageError(abort).code).toBe('Cancelled');
  });

  it('exports only safe retry metadata and stable messages', () => {
    const error = new StorageError('RateLimited', { retryAfterMs: 500, providerCode: 'SlowDown' });
    error.message = 'secret replacement message';
    expect(error.toJSON()).toEqual({
      code: 'RateLimited',
      message: 'The storage service is rate limiting requests.',
      retryHint: 'safe',
      retryAfterMs: 500,
      providerCode: 'SlowDown',
    });
    const unsafe = new StorageError('NetworkError', {
      retryAfterMs: Number.NaN,
      providerCode: 'https://private.invalid/token',
    });
    expect(unsafe.toJSON()).not.toHaveProperty('providerCode');
    expect(unsafe.toJSON()).not.toHaveProperty('retryAfterMs');
  });
});
