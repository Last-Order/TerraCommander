import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type {
  DiscardResult,
  Entry,
  SourceDescriptor,
  UploadStatus,
  WriteTarget,
} from '../../../shared/storage/models';
import {
  checkedEntry,
  requireCapabilities,
  targetRef,
  writeRequirements,
} from '../core/adapter-operations';
import type {
  DriverCheckpoint,
  OperationContext,
  ReopenableByteSource,
  UploadDriver,
} from '../core/contracts';
import { normalizeStorageError, StorageError, throwIfAborted } from '../core/errors';
import { verifySource } from '../core/streams';
import {
  driverCheckpointSchema,
  parse,
  progressSchema,
  sourceDescriptorSchema,
  writeTargetSchema,
} from '../core/validation';
import type { CheckpointStore } from '../ports/services';
import type { AdapterLease, AdapterRegistry } from '../registry/adapter-registry';
import { CheckpointRepository } from './checkpoint-repository';
import {
  completedEntry,
  publicStatus,
  validateDriverCheckpoint,
  validateUploadProgress,
  type UploadCheckpoint,
} from './checkpoints';
import { UploadExecution } from './upload-execution';

const discardResultSchema = z.strictObject({
  cleanup: z.enum(['complete', 'pending', 'unsupported']),
});

const uploadObservationSchema = z.strictObject({
  checkpoint: driverCheckpointSchema,
  progress: progressSchema,
  state: z.enum(['suspended', 'unknown', 'expired', 'completed']),
  entry: z.unknown().optional(),
});

/** Coordinates session recovery. The host must assign each backing store a single owner. */
export class UploadCoordinator {
  private readonly activeUploads = new Set<string>();
  private readonly checkpoints: CheckpointRepository;

  constructor(
    private readonly registry: AdapterRegistry,
    store: CheckpointStore,
  ) {
    this.checkpoints = new CheckpointRepository(store);
  }

  async create(
    inputTarget: WriteTarget,
    inputSource: SourceDescriptor,
    context: OperationContext = {},
  ): Promise<string> {
    const target = parse(writeTargetSchema, inputTarget);
    const source = parse(sourceDescriptorSchema, inputSource);
    const destination = targetRef(target);
    const lease = await this.registry.acquire(destination.connectionId, context);
    let driver: UploadDriver | undefined;
    let driverCheckpoint: DriverCheckpoint | undefined;

    try {
      driver = await this.getUploadDriver(lease, target);
      driverCheckpoint = validateDriverCheckpoint(
        driver,
        await driver.create(target, source, lease.context),
      );
      throwIfAborted(lease.context.signal);

      const createdAt = new Date().toISOString();
      const uploadId = randomUUID();

      // Creation records the session before any content is allowed to flow.
      await this.checkpoints.save({
        version: 1,
        id: uploadId,
        connectionId: destination.connectionId,
        provider: lease.definition.provider,
        connectionFingerprint: lease.fingerprint,
        target,
        source,
        driver: driverCheckpoint,
        state: 'created',
        progress: { processedBytes: 0, confirmedBytes: 0 },
        createdAt,
        updatedAt: createdAt,
      });

      return uploadId;
    } catch (error) {
      // No bytes have been sent yet. Discard an unrecorded session on a best-effort basis.
      if (driver && driverCheckpoint) {
        await driver.discard(driverCheckpoint, {}).catch(() => undefined);
      }
      throw normalizeStorageError(error);
    } finally {
      lease.release();
    }
  }

  async inspect(uploadId: string, context: OperationContext = {}): Promise<UploadStatus> {
    return this.withUploadLock(uploadId, context, async () => {
      let checkpoint = await this.checkpoints.load(uploadId);
      const lease = await this.acquireSessionConnection(checkpoint, context);

      try {
        const isTerminal = ['completed', 'discarded', 'expired'].includes(checkpoint.state);

        if (!isTerminal) {
          const driver = await this.getUploadDriver(lease, checkpoint.target);
          checkpoint = await this.reconcileCheckpoint(checkpoint, driver, lease.context);
        }

        return publicStatus(checkpoint);
      } finally {
        lease.release();
      }
    });
  }

  async resume(
    uploadId: string,
    source: ReopenableByteSource,
    context: OperationContext = {},
  ): Promise<Entry> {
    return this.withUploadLock(uploadId, context, async () => {
      let checkpoint = await this.checkpoints.load(uploadId);
      const lease = await this.acquireSessionConnection(checkpoint, context);

      try {
        if (checkpoint.state === 'discarded') {
          throw new StorageError('ResumeInvalid');
        }
        if (checkpoint.state === 'expired') {
          throw new StorageError('ResumeExpired');
        }
        if (checkpoint.state === 'completed') {
          return completedEntry(checkpoint);
        }

        // Backend truth resolves both interrupted progress and a lost final response.
        const driver = await this.getUploadDriver(lease, checkpoint.target);
        checkpoint = await this.reconcileCheckpoint(checkpoint, driver, lease.context);

        if (checkpoint.state === 'completed') {
          return completedEntry(checkpoint);
        }
        if (checkpoint.state === 'expired') {
          throw new StorageError('ResumeExpired');
        }
        if (checkpoint.state === 'unknown') {
          throw new StorageError('OutcomeUnknown');
        }
        if (source.kind !== 'reopenable') {
          throw new StorageError('ResumeInvalid');
        }

        await verifySource(source, checkpoint.source, lease.context);
        const execution = new UploadExecution(checkpoint, driver, this.checkpoints, lease.context);
        return await execution.run(source);
      } finally {
        lease.release();
      }
    });
  }

  async discard(uploadId: string, context: OperationContext = {}): Promise<DiscardResult> {
    return this.withUploadLock(uploadId, context, async () => {
      let checkpoint = await this.checkpoints.load(uploadId);
      const lease = await this.acquireSessionConnection(checkpoint, context);

      try {
        if (checkpoint.state === 'completed') {
          throw new StorageError('PreconditionFailed');
        }
        if (checkpoint.state === 'discarded' && checkpoint.cleanup === 'complete') {
          return { cleanup: 'complete' };
        }

        const driver = await this.getUploadDriver(lease, checkpoint.target);
        const needsReconciliation =
          checkpoint.state !== 'discarded' && checkpoint.state !== 'expired';

        if (needsReconciliation) {
          checkpoint = await this.reconcileCheckpoint(checkpoint, driver, lease.context);

          // A session may have committed before its last response was lost.
          if (checkpoint.state === 'completed') {
            throw new StorageError('PreconditionFailed');
          }
        }

        const driverCheckpoint = validateDriverCheckpoint(driver, checkpoint.driver);
        const result = parse(
          discardResultSchema,
          await driver.discard(driverCheckpoint, lease.context),
          'OutcomeUnknown',
        );

        await this.checkpoints.save({ ...checkpoint, state: 'discarded', cleanup: result.cleanup });
        return result;
      } finally {
        lease.release();
      }
    });
  }

  private async getUploadDriver(lease: AdapterLease, target: WriteTarget): Promise<UploadDriver> {
    const capabilities = await requireCapabilities(
      lease.adapter,
      targetRef(target),
      [...writeRequirements(target), { operation: 'resumeWrite', strict: true }],
      lease.context,
    );

    // Ordinary upload support alone does not promise recovery after a restart.
    const supportsDurableRecovery = capabilities.resumeWrite?.guarantees?.durableRecovery === true;
    if (!lease.adapter.uploads || !supportsDurableRecovery) {
      throw new StorageError('Unsupported');
    }

    return lease.adapter.uploads;
  }

  private async reconcileCheckpoint(
    checkpoint: UploadCheckpoint,
    driver: UploadDriver,
    context: OperationContext,
  ): Promise<UploadCheckpoint> {
    const observation = parse(
      uploadObservationSchema,
      await driver.reconcile(validateDriverCheckpoint(driver, checkpoint.driver), context),
      'ResumeInvalid',
    );
    const driverCheckpoint = validateDriverCheckpoint(driver, observation.checkpoint);
    const progress = validateUploadProgress(observation.progress, checkpoint.source.size);

    if (observation.state === 'completed') {
      if (progress.confirmedBytes !== checkpoint.source.size) {
        throw new StorageError('ResumeInvalid');
      }

      const destination = targetRef(checkpoint.target);
      const entry = checkedEntry(observation.entry, checkpoint.connectionId, destination.spaceId);
      return this.checkpoints.save({
        ...checkpoint,
        driver: driverCheckpoint,
        progress,
        state: 'completed',
        entry,
      });
    }

    return this.checkpoints.save({
      ...checkpoint,
      driver: driverCheckpoint,
      progress,
      state: observation.state,
    });
  }

  private async acquireSessionConnection(
    checkpoint: UploadCheckpoint,
    context: OperationContext,
  ): Promise<AdapterLease> {
    const lease = await this.registry.acquire(checkpoint.connectionId, context);
    const matchesConnection =
      lease.fingerprint === checkpoint.connectionFingerprint &&
      lease.definition.provider === checkpoint.provider;

    if (!matchesConnection) {
      lease.release();
      throw new StorageError('ResumeInvalid');
    }

    return lease;
  }

  private async withUploadLock<T>(
    uploadId: string,
    context: OperationContext,
    run: () => Promise<T>,
  ): Promise<T> {
    if (typeof uploadId !== 'string' || !uploadId) {
      throw new StorageError('InvalidArgument');
    }
    throwIfAborted(context.signal);

    if (this.activeUploads.has(uploadId)) {
      throw new StorageError('PreconditionFailed');
    }

    // This guards one coordinator instance; cross-process exclusion belongs to its host.
    this.activeUploads.add(uploadId);
    try {
      return await run();
    } catch (error) {
      throw normalizeStorageError(error);
    } finally {
      this.activeUploads.delete(uploadId);
    }
  }
}
