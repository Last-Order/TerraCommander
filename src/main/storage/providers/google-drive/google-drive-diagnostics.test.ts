import { expect, it, vi } from 'vitest';
import { StorageError } from '../../core/errors';
import { logGoogleDriveFailure } from './google-drive-diagnostics';

it('records a safe nested network cause without exposing provider details', () => {
  const event = vi.fn();
  const error = new StorageError('NetworkError', {
    cause: new TypeError('private signed URL and token', {
      cause: Object.assign(new Error('private connection details'), { code: 'ECONNRESET' }),
    }),
  });
  logGoogleDriveFailure({ event }, error, {
    stage: 'headers',
    timedOut: false,
    rangeRequested: true,
  });
  expect(event).toHaveBeenCalledExactlyOnceWith('google-drive.request.failed', {
    stage: 'headers',
    timedOut: false,
    rangeRequested: true,
    errorCode: 'NetworkError',
    networkCode: 'ECONNRESET',
  });
  expect(JSON.stringify(event.mock.calls)).not.toContain('private');
});

it('ignores cancellation and excludes arbitrary provider codes even for cyclic causes', () => {
  const event = vi.fn();
  logGoogleDriveFailure({ event }, new StorageError('Cancelled'), {
    stage: 'body',
    timedOut: false,
  });
  expect(event).not.toHaveBeenCalled();
  const cause: { code: string; cause?: unknown } = { code: 'private-token' };
  cause.cause = cause;
  logGoogleDriveFailure({ event }, new StorageError('NetworkError', { cause }), {
    stage: 'headers',
    timedOut: true,
  });
  expect(event).toHaveBeenCalledExactlyOnceWith('google-drive.request.failed', {
    stage: 'headers',
    timedOut: true,
    errorCode: 'NetworkError',
  });
});

it('keeps logger failures from replacing the original failure', () => {
  expect(() =>
    logGoogleDriveFailure(
      {
        event: () => {
          throw new Error('logger failed');
        },
      },
      new StorageError('NetworkError'),
      { stage: 'metadata', timedOut: false },
    ),
  ).not.toThrow();
});
