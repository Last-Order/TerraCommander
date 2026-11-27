import type { OperationContext } from '@main/storage/core/contracts';
import type {
  ContentChecksum,
  Entry,
  EntryRef,
  RemoveOptions,
  StorageErrorCode,
} from '@shared/storage';
import type { StorageProvider } from '@shared/storage-browser';
import type { StorageDirectory } from '../storage/storage-directory';
import type { StorageFile } from '../storage/storage-file';

export type TransferMode = 'copy' | 'move';
export type TransferStage = 'transferring' | 'finalizing';

export interface TransferWorkRef {
  readonly planId: string;
  readonly itemId: number;
}

export interface TransferProgress {
  controls: { cancellable: boolean; pausable: boolean };
  stage: TransferStage;
  completedBytes: number;
  totalBytes?: number | undefined;
  bytesPerSecond?: number | undefined;
}

export type TransferRunResult =
  | { status: 'completed'; entry: Entry; sourceSnapshot: TransferSourceSnapshot }
  | { status: 'paused'; completedBytes: number; totalBytes?: number | undefined; error?: unknown }
  | { status: 'cancelled' }
  | { status: 'skipped' };

export interface TransferSourceSnapshot {
  readonly ref: EntryRef;
  readonly parent: EntryRef;
  readonly name: string;
  readonly kind: Entry['kind'];
  readonly size?: number | undefined;
  readonly revision?: string | undefined;
  readonly checksum?: ContentChecksum | undefined;
}

export interface CommittedTransferFile {
  readonly itemId: number;
  readonly targetEntry: Entry;
  readonly targetParent: EntryRef;
  readonly sourceSnapshot: TransferSourceSnapshot;
  sourceDeleted: boolean;
}

export interface SourceDirectoryCleanupEntry {
  readonly ref: EntryRef;
  readonly parent: EntryRef;
  readonly depth: number;
  readonly revision?: string | undefined;
  removed: boolean;
}

export interface TransferPlanItem {
  readonly id: number;
  readonly entry: Entry;
  readonly sourceParent: EntryRef;
  readonly targetParent: EntryRef;
  readonly targetName: string;
  readonly relativePath: string;
  readonly replace: boolean;
  readonly existingTarget?: Entry | undefined;
  readonly code?: StorageErrorCode | undefined;
}

export interface TransferPlanPage {
  items: TransferPlanItem[];
  nextOffset?: number | undefined;
}

export interface TransferWork {
  readonly ref: TransferWorkRef;
  readonly item: TransferPlanItem;
  readonly mode: TransferMode;
  readonly sourceProvider: StorageProvider;
  readonly targetProvider: StorageProvider;
}

export interface PreparedTransferBatch {
  readonly id: string;
  readonly mode: TransferMode;
  readonly sourceProvider: StorageProvider;
  readonly targetProvider: StorageProvider;
  readonly targetParent: EntryRef;
  readonly conflicts: string[];
  readonly items: TransferPlanItem[];
}

export interface PrepareTransferRequest {
  readonly mode: TransferMode;
  readonly sourceParent: EntryRef;
  readonly targetParent: EntryRef;
  readonly entries: readonly Entry[];
  readonly replace?: boolean | undefined;
  readonly onDirectoryCreated?: ((parent: EntryRef, entry: Entry) => void) | undefined;
}

export interface TransferOperations {
  directory(ref: EntryRef): StorageDirectory;
  file(ref: EntryRef): StorageFile;
  statEntry(ref: EntryRef, context?: OperationContext): Promise<Entry>;
  deleteEntry(ref: EntryRef, context?: OperationContext, options?: RemoveOptions): Promise<void>;
  resolveProvider(connectionId: string): Promise<StorageProvider>;
  validateEntryName?(connectionId: string, name: string): Promise<boolean>;
  canonicalEntryKey?(ref: EntryRef): Promise<string | undefined>;
}
