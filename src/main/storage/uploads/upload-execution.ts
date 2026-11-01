import type { Entry, UploadProgress, UploadState } from '../../../shared/storage/models';
import { checkedEntry, targetRef } from '../core/adapter-operations';
import type {
  DriverCheckpoint,
  OperationContext,
  ReopenableByteSource,
  UploadDriver,
} from '../core/contracts';
import { normalizeStorageError, StorageError, throwIfAborted } from '../core/errors';
import { scopeSource } from '../core/streams';
import type { CheckpointRepository } from './checkpoint-repository';
import {
  completedEntry,
  validateDriverCheckpoint,
  validateUploadProgress,
  type UploadCheckpoint,
} from './checkpoints';

/** Owns one run's mutable checkpoint and serializes acknowledgements from concurrent parts. */
export class UploadExecution {
  private pendingCheckpointWrites = Promise.resolve();

  constructor(
    private checkpoint: UploadCheckpoint,
    private readonly driver: UploadDriver,
    private readonly repository: CheckpointRepository,
    private readonly context: OperationContext,
  ) {}

  async run(source: ReopenableByteSource): Promise<Entry> {
    const sourceScope = scopeSource(source, this.context);
    if (sourceScope.source.kind !== 'reopenable') {
      throw new StorageError('ResumeInvalid');
    }

    try {
      this.checkpoint = await this.repository.save({ ...this.checkpoint, state: 'active' });

      const uploadedEntry = await this.driver.run(
        this.checkpoint.driver,
        sourceScope.source,
        {
          checkpoint: (driverState, progress) => this.saveAcknowledgement(driverState, progress),
        },
        this.context,
      );

      // Finalization must not overtake an acknowledgement that is still being persisted.
      await this.pendingCheckpointWrites;
      return await this.complete(uploadedEntry);
    } catch (error) {
      await this.recordInterruption(error);
      throw normalizeStorageError(error);
    } finally {
      await sourceScope.dispose();
    }
  }

  private saveAcknowledgement(
    driverState: DriverCheckpoint,
    inputProgress: UploadProgress,
  ): Promise<void> {
    // Snapshot immediately: a multipart driver may reuse its mutable state for the next callback.
    const progress = validateUploadProgress(inputProgress, this.checkpoint.source.size);
    const driverCheckpoint = validateDriverCheckpoint(this.driver, driverState);

    const saving = this.pendingCheckpointWrites.then(async () => {
      if (progress.confirmedBytes < this.checkpoint.progress.confirmedBytes) {
        throw new StorageError('ResumeInvalid');
      }

      this.checkpoint = await this.repository.save({
        ...this.checkpoint,
        driver: driverCheckpoint,
        progress,
        state: 'active',
      });

      this.context.onProgress?.({ ...progress, totalBytes: this.checkpoint.source.size });

      // Preserve acknowledged bytes even if cancellation arrived during the durable save.
      throwIfAborted(this.context.signal);
    });

    this.pendingCheckpointWrites = saving;

    // The driver awaits the returned promise; this handler also covers an early driver failure.
    void saving.catch(() => {});
    return saving;
  }

  private async complete(uploadedEntry: Entry): Promise<Entry> {
    const destination = targetRef(this.checkpoint.target);
    const entry = checkedEntry(uploadedEntry, this.checkpoint.connectionId, destination.spaceId);
    const totalBytes = this.checkpoint.source.size;

    this.checkpoint = await this.repository.save({
      ...this.checkpoint,
      state: 'completed',
      entry,
      progress: {
        processedBytes: Math.max(this.checkpoint.progress.processedBytes, totalBytes),
        confirmedBytes: totalBytes,
      },
    });

    return completedEntry(this.checkpoint);
  }

  private async recordInterruption(error: unknown): Promise<void> {
    // Let queued writes settle before saving the last known recoverable state.
    await this.pendingCheckpointWrites.catch(() => {});
    const failure = normalizeStorageError(error);
    const state = interruptedUploadState(failure);

    // A secondary store failure must not hide the operation failure that caused suspension.
    await this.repository.save({ ...this.checkpoint, state }).catch(() => undefined);
  }
}

function interruptedUploadState(failure: StorageError): UploadState {
  if (failure.code === 'ResumeExpired') {
    return 'expired';
  }

  if (failure.code === 'Cancelled' || failure.retryHint === 'safe') {
    return 'suspended';
  }

  // A failed response can conceal a successful commit. Reconcile before continuing.
  return 'unknown';
}
