import { StorageError } from '../core/errors';
import type { CheckpointStore } from '../ports/services';
import { validateCheckpoint, type UploadCheckpoint } from './checkpoints';

/** Validates snapshots at the persistence boundary; the store owns durability and encryption. */
export class CheckpointRepository {
  constructor(private readonly store: CheckpointStore) {}

  async load(uploadId: string): Promise<UploadCheckpoint> {
    const storedValue = await this.store.load(uploadId);

    if (storedValue === undefined) {
      throw new StorageError('NotFound');
    }

    return validateCheckpoint(storedValue, uploadId);
  }

  async save(checkpoint: UploadCheckpoint): Promise<UploadCheckpoint> {
    const snapshot = validateCheckpoint(
      { ...checkpoint, updatedAt: new Date().toISOString() },
      checkpoint.id,
    );

    // A store must not be able to mutate the in-flight session through a shared reference.
    await this.store.save(snapshot.id, structuredClone(snapshot));
    return snapshot;
  }
}
