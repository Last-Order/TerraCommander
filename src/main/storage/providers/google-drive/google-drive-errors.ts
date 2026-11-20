import { z } from 'zod';
import { StorageError } from '@main/storage/core/errors';

const failureSchema = z.object({
  error: z.object({ errors: z.array(z.object({ reason: z.string() })).optional() }),
});

export function driveFailure(status: number, payload: unknown): StorageError {
  if (status === 401) return new StorageError('AuthRequired');
  if (status === 404) return new StorageError('NotFound');
  const failure = failureSchema.safeParse(payload);
  const limited = failure.data?.error.errors?.some(({ reason }) =>
    /ratelimit|quota|dailylimit/i.test(reason),
  );
  if (status === 429 || limited) return new StorageError('RateLimited');
  if (status === 403) return new StorageError('PermissionDenied');
  if (status === 400) return new StorageError('InvalidArgument');
  return new StorageError(status >= 500 ? 'NetworkError' : 'OutcomeUnknown');
}
