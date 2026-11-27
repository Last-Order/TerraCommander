import { randomUUID } from 'node:crypto';
import { StorageError } from '@main/storage';
import { mergeResourceLocks, type ResourceLocks } from '@main/tasks/conflict-ledger';
import { entryKey, type Entry, type EntryRef } from '@shared/storage';
import type { ConflictConfirmationResponse, StorageDirectoryChange } from '@shared/tasks';
import type { TransferService } from '../transfers/transfer-service';
import type {
  PreparedTransferBatch,
  TransferMode,
  TransferWork,
} from '../transfers/transfer-types';

export const queueOwnerId = 0;

async function releaseQuietly(action: () => Promise<void>, message: string): Promise<void> {
  try {
    await action();
  } catch {
    console.error(message);
  }
}

export interface SessionTransferRequest {
  readonly mode: TransferMode;
  readonly sourceParent: EntryRef;
  readonly sourceDirectoryPath: string;
  readonly entries: readonly Entry[];
  readonly targetParent: EntryRef;
  readonly targetDirectoryPath: string;
}

type PendingConfirmation =
  | {
      kind: 'single';
      owner: number;
      reservationId: string;
      request: SessionTransferRequest;
      work: TransferWork;
    }
  | {
      kind: 'batch';
      owner: number;
      reservationId: string;
      request: SessionTransferRequest;
      prepared: PreparedTransferBatch;
    };

export interface TransferSessionHost {
  transfers: TransferService;
  targetLockKeys: (parent: EntryRef, names: readonly string[]) => Promise<ResourceLocks>;
  reserveLocks: (locks: ResourceLocks) => string | undefined;
  releaseReservation: (reservationId: string) => void;
  enqueueTransfer: (
    request: SessionTransferRequest,
    work: TransferWork,
    reservationId: string,
  ) => boolean;
  enqueueTransferGroup: (
    request: SessionTransferRequest,
    prepared: PreparedTransferBatch,
    reservationId: string,
  ) => boolean;
  emitDirectoryChanged: (change: StorageDirectoryChange) => void;
}

/** Coordinates pre-enqueue reservations, overwrite confirmations, atomic lock handoff, and owner epochs. */
export class TransferSessionCoordinator {
  private readonly confirmations = new Map<string, PendingConfirmation>();
  private readonly ownerEpochs = new Map<number, number>();
  private readonly dialogPickers = new Set<number>();
  private disposed = false;

  constructor(private readonly host: TransferSessionHost) {}

  async runWithDialogLock<T>(owner: number, run: () => Promise<T>): Promise<T | undefined> {
    if (this.disposed || this.dialogPickers.has(owner)) return undefined;
    const epoch = this.ownerEpochs.get(owner) ?? 0;
    this.dialogPickers.add(owner);
    try {
      const result = await run();
      if (this.disposed || (this.ownerEpochs.get(owner) ?? 0) !== epoch) return undefined;
      return result;
    } finally {
      this.dialogPickers.delete(owner);
    }
  }

  async prepareTransfer(
    owner: number,
    request: SessionTransferRequest,
  ): Promise<ConflictConfirmationResponse> {
    if (this.disposed) throw new StorageError('Cancelled');
    if (request.entries.length === 0) throw new StorageError('InvalidArgument');
    const epoch = this.ownerEpochs.get(owner) ?? 0;

    const preparedResult = await this.host.transfers.prepare(queueOwnerId, {
      mode: request.mode,
      sourceParent: request.sourceParent,
      targetParent: request.targetParent,
      entries: request.entries,
      onDirectoryCreated: (parent, entry) => {
        this.host.emitDirectoryChanged({ kind: 'added', parent, entry });
      },
    });

    const releasePrepared = () =>
      preparedResult.kind === 'single'
        ? releaseQuietly(
            () => this.host.transfers.releaseWork(queueOwnerId, preparedResult.work.ref),
            'Transfer work cleanup failed.',
          )
        : releaseQuietly(
            () => this.host.transfers.releasePlan(queueOwnerId, preparedResult.prepared.id),
            'Transfer plan cleanup failed.',
          );

    if (this.disposed || (this.ownerEpochs.get(owner) ?? 0) !== epoch) {
      await releasePrepared();
      throw new StorageError('Cancelled');
    }

    const targetNames =
      preparedResult.kind === 'single'
        ? [preparedResult.work.item.targetName]
        : preparedResult.prepared.items.map((item) => item.targetName);
    const sourceLocks = request.entries.map((entry) => entryKey(entry.ref));
    let locks: ResourceLocks;
    try {
      const targetLocks = await this.host.targetLockKeys(request.targetParent, targetNames);
      locks = mergeResourceLocks(targetLocks, sourceLocks);
    } catch (error) {
      await releasePrepared();
      throw error;
    }

    if (this.disposed || (this.ownerEpochs.get(owner) ?? 0) !== epoch) {
      await releasePrepared();
      throw new StorageError('Cancelled');
    }

    const reservationId = this.host.reserveLocks(locks);
    if (!reservationId) {
      await releasePrepared();
      throw new StorageError('PreconditionFailed');
    }

    const conflicts =
      preparedResult.kind === 'single'
        ? preparedResult.conflicts
        : preparedResult.prepared.conflicts;

    if (conflicts.length > 0) {
      const confirmationId = randomUUID();
      if (preparedResult.kind === 'single') {
        this.confirmations.set(confirmationId, {
          kind: 'single',
          owner,
          reservationId,
          request,
          work: preparedResult.work,
        });
        return { status: 'conflict', confirmationId };
      }
      this.confirmations.set(confirmationId, {
        kind: 'batch',
        owner,
        reservationId,
        request,
        prepared: preparedResult.prepared,
      });
      return { status: 'conflict', confirmationId, conflicts };
    }

    const enqueued =
      preparedResult.kind === 'single'
        ? this.host.enqueueTransfer(request, preparedResult.work, reservationId)
        : this.host.enqueueTransferGroup(request, preparedResult.prepared, reservationId);

    if (!enqueued) {
      this.host.releaseReservation(reservationId);
      await releasePrepared();
      throw new StorageError('PreconditionFailed');
    }

    return { status: 'started' };
  }

  async confirmTransfer(owner: number, confirmationId: string): Promise<void> {
    if (this.disposed) throw new StorageError('Cancelled');
    const confirmation = this.confirmations.get(confirmationId);
    if (!confirmation || confirmation.owner !== owner) {
      throw new StorageError('InvalidArgument');
    }
    this.confirmations.delete(confirmationId);

    const planId =
      confirmation.kind === 'single' ? confirmation.work.ref.planId : confirmation.prepared.id;

    try {
      this.host.transfers.confirmPlan(queueOwnerId, planId);
    } catch (error) {
      this.host.releaseReservation(confirmation.reservationId);
      await releaseQuietly(
        () => this.host.transfers.releasePlan(queueOwnerId, planId),
        'Transfer plan cleanup failed.',
      );
      throw error;
    }

    const enqueued =
      confirmation.kind === 'single'
        ? this.host.enqueueTransfer(
            confirmation.request,
            confirmation.work,
            confirmation.reservationId,
          )
        : this.host.enqueueTransferGroup(
            confirmation.request,
            confirmation.prepared,
            confirmation.reservationId,
          );

    if (!enqueued) {
      this.host.releaseReservation(confirmation.reservationId);
      await releaseQuietly(
        () => this.host.transfers.releasePlan(queueOwnerId, planId),
        'Transfer plan cleanup failed.',
      );
      throw new StorageError('PreconditionFailed');
    }
  }

  async cancelTransferConfirmation(owner: number, confirmationId: string): Promise<void> {
    const confirmation = this.confirmations.get(confirmationId);
    if (!confirmation || confirmation.owner !== owner) return;
    this.confirmations.delete(confirmationId);
    this.host.releaseReservation(confirmation.reservationId);
    const planId =
      confirmation.kind === 'single' ? confirmation.work.ref.planId : confirmation.prepared.id;
    await this.host.transfers.releasePlan(queueOwnerId, planId);
  }

  cancelOwnerConfirmations(owner: number): void {
    this.ownerEpochs.set(owner, (this.ownerEpochs.get(owner) ?? 0) + 1);
    for (const [id, confirmation] of this.confirmations) {
      if (confirmation.owner !== owner) continue;
      this.confirmations.delete(id);
      this.host.releaseReservation(confirmation.reservationId);
      const planId =
        confirmation.kind === 'single' ? confirmation.work.ref.planId : confirmation.prepared.id;
      void releaseQuietly(
        () => this.host.transfers.releasePlan(queueOwnerId, planId),
        'Transfer plan cleanup failed.',
      );
    }
  }

  dispose(): Promise<void>[] {
    this.disposed = true;
    const pendingCleanups: Promise<void>[] = [];
    for (const [id, confirmation] of this.confirmations) {
      this.confirmations.delete(id);
      this.host.releaseReservation(confirmation.reservationId);
      const planId =
        confirmation.kind === 'single' ? confirmation.work.ref.planId : confirmation.prepared.id;
      pendingCleanups.push(
        releaseQuietly(
          () => this.host.transfers.releasePlan(queueOwnerId, planId),
          'Transfer plan cleanup failed.',
        ),
      );
    }
    return pendingCleanups;
  }
}
