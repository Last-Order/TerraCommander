import { randomUUID } from 'node:crypto';
import type { Entry } from '@shared/storage';
import type {
  PrepareDownloadRequest,
  PrepareDownloadResponse,
  StorageDirectoryChange,
  UploadFileRequest,
  UploadPathsRequest,
} from '@shared/tasks';
import { StorageError } from '@main/storage';
import { DownloadError } from '../downloads/download-paths';
import type { DownloadWork, PreparedDownloadBatch } from '../downloads/download-types';
import type { StorageBrowser } from '../storage/storage-browser';
import type { PreparedUploadBatch, UploadWork } from '../uploads/upload-types';
import { queueOwnerId, releaseQuietly, toBrowserErrorCode } from './task-errors';

type PendingConfirmation =
  | { kind: 'single'; owner: number; request: PrepareDownloadRequest; entry: Entry }
  | {
      kind: 'batch';
      owner: number;
      request: PrepareDownloadRequest;
      prepared: PreparedDownloadBatch;
    };

export interface TransferSessionHost {
  downloads: StorageBrowser['downloads'];
  uploads: StorageBrowser['uploads'];
  enqueueDownload: (request: PrepareDownloadRequest, entry: Entry, work: DownloadWork) => boolean;
  enqueueDownloadGroup: (
    request: PrepareDownloadRequest,
    prepared: PreparedDownloadBatch,
  ) => boolean;
  enqueueUpload: (request: UploadFileRequest, work: UploadWork) => boolean;
  enqueueUploadGroup: (request: UploadFileRequest, prepared: PreparedUploadBatch) => boolean;
  emitDirectoryChanged: (change: StorageDirectoryChange) => void;
}

/** Coordinates pre-enqueue picker locks, download overwrite confirmations, and owner session epochs. */
export class TransferSessionCoordinator {
  private readonly confirmations = new Map<string, PendingConfirmation>();
  private readonly ownerEpochs = new Map<number, number>();
  private readonly uploadPickers = new Set<number>();
  private disposed = false;

  constructor(private readonly host: TransferSessionHost) {}

  async uploadFile(
    owner: number,
    request: UploadFileRequest,
    pickFile: () => Promise<string | undefined>,
  ): Promise<void> {
    await this.uploadPaths(owner, request, async () => {
      const path = await pickFile();
      return path ? [path] : [];
    });
  }

  async uploadPaths(
    owner: number,
    request: UploadFileRequest,
    pickPaths: () => Promise<readonly string[]>,
    options?: { requireCreateDirectory?: boolean },
  ): Promise<void> {
    if (this.disposed || this.uploadPickers.has(owner)) return;
    const epoch = this.ownerEpochs.get(owner) ?? 0;
    const active = () => !this.disposed && (this.ownerEpochs.get(owner) ?? 0) === epoch;
    this.uploadPickers.add(owner);
    try {
      await this.host.uploads.validateDestination(request.parent, options?.requireCreateDirectory);
      if (!active()) return;
      const paths = await pickPaths();
      if (paths.length === 0 || !active()) return;
      await this.prepareAndEnqueueUpload(owner, request, paths, true);
    } finally {
      this.uploadPickers.delete(owner);
    }
  }

  async uploadSelectedPaths(owner: number, request: UploadPathsRequest): Promise<void> {
    if (this.disposed || request.paths.length === 0) return;
    await this.prepareAndEnqueueUpload(owner, request, request.paths, false);
  }

  private async prepareAndEnqueueUpload(
    owner: number,
    request: UploadFileRequest,
    paths: readonly string[],
    validated: boolean,
  ): Promise<void> {
    const epoch = this.ownerEpochs.get(owner) ?? 0;
    const active = () => !this.disposed && (this.ownerEpochs.get(owner) ?? 0) === epoch;
    const selection = await this.host.uploads.prepareSelection(queueOwnerId, {
      parent: request.parent,
      paths,
      validated,
      onDirectoryCreated: (parent, entry) => {
        this.host.emitDirectoryChanged({ kind: 'added', parent, entry });
      },
    });
    if (!active()) {
      await (selection.kind === 'single'
        ? releaseQuietly(
            () => this.host.uploads.releaseWork(queueOwnerId, selection.work.ref),
            'Upload work cleanup failed.',
          )
        : releaseQuietly(
            () => this.host.uploads.releaseBatch(queueOwnerId, selection.prepared.id),
            'Upload batch cleanup failed.',
          ));
      return;
    }
    if (selection.kind === 'single') {
      if (!this.host.enqueueUpload(request, selection.work)) {
        await releaseQuietly(
          () => this.host.uploads.releaseWork(queueOwnerId, selection.work.ref),
          'Upload work cleanup failed.',
        );
      }
      return;
    }
    if (!this.host.enqueueUploadGroup(request, selection.prepared)) {
      await releaseQuietly(
        () => this.host.uploads.releaseBatch(queueOwnerId, selection.prepared.id),
        'Upload batch cleanup failed.',
      );
    }
  }

  async prepareDownload(
    owner: number,
    request: PrepareDownloadRequest,
  ): Promise<PrepareDownloadResponse> {
    if (this.disposed) throw new StorageError('Cancelled');
    if (request.entries.length === 0) throw new StorageError('InvalidArgument');
    const epoch = this.ownerEpochs.get(owner) ?? 0;
    const single =
      request.entries.length === 1 && request.entries[0]?.kind === 'file'
        ? request.entries[0]
        : undefined;
    if (single) {
      let work: DownloadWork;
      try {
        work = await this.host.downloads.prepare(queueOwnerId, {
          ref: single.ref,
          directory: request.directory,
          expectedName: single.name,
          replace: false,
        });
      } catch (error) {
        if (
          !this.disposed &&
          (this.ownerEpochs.get(owner) ?? 0) === epoch &&
          toBrowserErrorCode(error) === 'AlreadyExists'
        ) {
          const confirmationId = randomUUID();
          this.confirmations.set(confirmationId, {
            kind: 'single',
            owner,
            request,
            entry: single,
          });
          return { status: 'conflict', confirmationId };
        }
        throw error;
      }
      if (this.disposed || (this.ownerEpochs.get(owner) ?? 0) !== epoch) {
        await releaseQuietly(
          () => this.host.downloads.releaseWork(queueOwnerId, work.ref),
          'Download work cleanup failed.',
        );
        throw new StorageError('Cancelled');
      }
      if (!this.host.enqueueDownload(request, single, work)) {
        await releaseQuietly(
          () => this.host.downloads.releaseWork(queueOwnerId, work.ref),
          'Download work cleanup failed.',
        );
        throw new DownloadError('DownloadTargetBusy');
      }
      return { status: 'started' };
    }

    const prepared = await this.host.downloads.prepareBatch(queueOwnerId, {
      entries: request.entries.map((entry) => ({ ref: entry.ref, expectedName: entry.name })),
      directory: request.directory,
    });
    if (this.disposed || (this.ownerEpochs.get(owner) ?? 0) !== epoch) {
      await releaseQuietly(
        () => this.host.downloads.releaseBatch(queueOwnerId, prepared.id),
        'Download batch cleanup failed.',
      );
      throw new StorageError('Cancelled');
    }
    if (prepared.conflicts.length > 0) {
      const confirmationId = randomUUID();
      this.confirmations.set(confirmationId, {
        kind: 'batch',
        owner,
        request,
        prepared,
      });
      return { status: 'conflict', confirmationId, conflicts: prepared.conflicts };
    }
    if (!this.host.enqueueDownloadGroup(request, prepared)) {
      await releaseQuietly(
        () => this.host.downloads.releaseBatch(queueOwnerId, prepared.id),
        'Download batch cleanup failed.',
      );
      throw new DownloadError('DownloadTargetBusy');
    }
    return { status: 'started' };
  }

  async confirmDownload(owner: number, confirmationId: string): Promise<void> {
    if (this.disposed) throw new StorageError('Cancelled');
    const confirmation = this.confirmations.get(confirmationId);
    if (!confirmation || confirmation.owner !== owner) throw new StorageError('InvalidArgument');
    this.confirmations.delete(confirmationId);
    const epoch = this.ownerEpochs.get(owner) ?? 0;

    if (confirmation.kind === 'single') {
      const work = await this.host.downloads.prepare(queueOwnerId, {
        ref: confirmation.entry.ref,
        directory: confirmation.request.directory,
        expectedName: confirmation.entry.name,
        replace: true,
      });
      if (this.disposed || (this.ownerEpochs.get(owner) ?? 0) !== epoch) {
        await releaseQuietly(
          () => this.host.downloads.releaseWork(queueOwnerId, work.ref),
          'Download work cleanup failed.',
        );
        throw new StorageError('Cancelled');
      }
      if (!this.host.enqueueDownload(confirmation.request, confirmation.entry, work)) {
        await releaseQuietly(
          () => this.host.downloads.releaseWork(queueOwnerId, work.ref),
          'Download work cleanup failed.',
        );
        throw new DownloadError('DownloadTargetBusy');
      }
      return;
    }

    try {
      this.host.downloads.confirmBatch(queueOwnerId, confirmation.prepared.id);
    } catch (error) {
      await releaseQuietly(
        () => this.host.downloads.releaseBatch(queueOwnerId, confirmation.prepared.id),
        'Download batch cleanup failed.',
      );
      throw error;
    }
    if (!this.host.enqueueDownloadGroup(confirmation.request, confirmation.prepared)) {
      await releaseQuietly(
        () => this.host.downloads.releaseBatch(queueOwnerId, confirmation.prepared.id),
        'Download batch cleanup failed.',
      );
      throw new DownloadError('DownloadTargetBusy');
    }
  }

  async cancelDownloadConfirmation(owner: number, confirmationId: string): Promise<void> {
    const confirmation = this.confirmations.get(confirmationId);
    if (!confirmation || confirmation.owner !== owner) return;
    this.confirmations.delete(confirmationId);
    if (confirmation.kind === 'batch') {
      await this.host.downloads.releaseBatch(queueOwnerId, confirmation.prepared.id);
    }
  }

  cancelOwnerConfirmations(owner: number): void {
    this.ownerEpochs.set(owner, (this.ownerEpochs.get(owner) ?? 0) + 1);
    for (const [id, confirmation] of this.confirmations) {
      if (confirmation.owner !== owner) continue;
      this.confirmations.delete(id);
      if (confirmation.kind === 'batch') {
        void releaseQuietly(
          () => this.host.downloads.releaseBatch(queueOwnerId, confirmation.prepared.id),
          'Download batch cleanup failed.',
        );
      }
    }
  }

  dispose(): Promise<void>[] {
    this.disposed = true;
    const pendingBatches: Promise<void>[] = [];
    for (const [id, confirmation] of this.confirmations) {
      this.confirmations.delete(id);
      if (confirmation.kind === 'batch') {
        pendingBatches.push(
          releaseQuietly(
            () => this.host.downloads.releaseBatch(queueOwnerId, confirmation.prepared.id),
            'Download batch cleanup failed.',
          ),
        );
      }
    }
    return pendingBatches;
  }
}
