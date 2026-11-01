import { z } from 'zod';
import type { Entry, UploadProgress, UploadStatus } from '../../../shared/storage/models';
import type { DriverCheckpoint, UploadDriver } from '../core/contracts';
import { StorageError } from '../core/errors';
import {
  driverCheckpointSchema,
  entrySchema,
  parse,
  progressSchema,
  sourceDescriptorSchema,
  writeTargetSchema,
} from '../core/validation';

export const checkpointSchema = z.strictObject({
  version: z.literal(1),
  id: z.string().min(1),
  connectionId: z.string().min(1),
  provider: z.string().min(1),
  connectionFingerprint: z.string().min(1),
  target: writeTargetSchema,
  source: sourceDescriptorSchema,
  driver: driverCheckpointSchema,
  state: z.enum(['created', 'active', 'suspended', 'completed', 'expired', 'discarded', 'unknown']),
  progress: progressSchema,
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  entry: entrySchema.optional(),
  cleanup: z.enum(['complete', 'pending', 'unsupported']).optional(),
});

export type UploadCheckpoint = z.infer<typeof checkpointSchema>;

export function validateCheckpoint(input: unknown, id: string): UploadCheckpoint {
  const checkpoint = parse(checkpointSchema, input, 'ResumeInvalid');
  const destination =
    checkpoint.target.kind === 'create' ? checkpoint.target.parent : checkpoint.target.ref;

  if (
    checkpoint.id !== id ||
    checkpoint.connectionId !== destination.connectionId ||
    checkpoint.progress.confirmedBytes > checkpoint.source.size
  ) {
    throw new StorageError('ResumeInvalid');
  }
  if (
    checkpoint.state === 'completed' &&
    (!checkpoint.entry ||
      checkpoint.entry.ref.connectionId !== checkpoint.connectionId ||
      checkpoint.entry.ref.spaceId !== destination.spaceId ||
      checkpoint.progress.confirmedBytes !== checkpoint.source.size)
  ) {
    throw new StorageError('ResumeInvalid');
  }
  return checkpoint;
}

/** The common envelope is validated here; each driver owns its private payload schema. */
export function validateDriverCheckpoint(driver: UploadDriver, input: unknown): DriverCheckpoint {
  const checkpoint = parse(driverCheckpointSchema, input, 'ResumeInvalid');

  try {
    if (driver.validate(checkpoint)) {
      return checkpoint;
    }
  } catch {
    // Provider validation errors can contain private session data.
  }

  throw new StorageError('ResumeInvalid');
}

export function validateUploadProgress(input: unknown, totalBytes: number): UploadProgress {
  const progress = parse(progressSchema, input, 'ResumeInvalid');

  if (progress.confirmedBytes > totalBytes) {
    throw new StorageError('ResumeInvalid');
  }

  return progress;
}

export function completedEntry(checkpoint: UploadCheckpoint): Entry {
  if (!checkpoint.entry) {
    throw new StorageError('ResumeInvalid');
  }

  return structuredClone(checkpoint.entry);
}

export function publicStatus(checkpoint: UploadCheckpoint): UploadStatus {
  // Deliberately omit driver payloads, credential references, and source fingerprints.
  return structuredClone({
    id: checkpoint.id,
    state: checkpoint.state,
    progress: checkpoint.progress,
    totalBytes: checkpoint.source.size,
    ...(checkpoint.entry ? { entry: checkpoint.entry } : {}),
  });
}
