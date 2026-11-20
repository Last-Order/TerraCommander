import type { CreateTarget, Entry, EntryRef, StorageErrorCode } from '@shared/storage';
import type {
  OperationContext,
  ReopenableByteSource,
  WriteExecution,
} from '@main/storage/core/contracts';

/**
 * Policy when a destination directory already contains an item with the same name.
 * Matches single-file upload's `create-only` semantics by creating a new folder entry
 * and retaining its provider-assigned `EntryRef` for all descendants and retries.
 */
export type SameNameFolderPolicy = 'create-new';

export interface UploadDestination {
  stat(ref: EntryRef, context?: OperationContext): Promise<Entry>;
  createDirectory?(target: CreateTarget, context?: OperationContext): Promise<Entry>;
  prepareUpload(parent: EntryRef, name: string, source: ReopenableByteSource): WriteExecution;
}

export interface UploadWorkRef {
  planId: string;
  itemId: number;
}

export interface UploadWork {
  ref: UploadWorkRef;
  parent: EntryRef;
  name: string;
  size: number;
}

export interface UploadRequest {
  parent: EntryRef;
  path: string;
}

export interface UploadBatchRequest {
  parent: EntryRef;
  paths: readonly string[];
  policy?: SameNameFolderPolicy;
  validated?: boolean;
  onDirectoryCreated?: (parent: EntryRef, entry: Entry) => void;
}

export interface UploadPlanItem {
  id: number;
  kind: 'file' | 'directory';
  path: string;
  localPath: string;
  name: string;
  size: number;
  parent: EntryRef;
  code?: StorageErrorCode;
}

export interface UploadPlanPage {
  items: UploadPlanItem[];
  nextOffset?: number;
}

export interface PreparedUploadBatch {
  id: string;
  sourcePath: string;
  items: UploadPlanItem[];
}

export interface ResolvedUploadWork {
  parent: EntryRef;
  name: string;
  size: number;
  prepare: () => WriteExecution;
}

export interface UploadProgress {
  controls: {
    cancellable: boolean;
    pausable: boolean;
  };
  stage: 'sending';
  confirmedBytes: number;
  totalBytes: number;
  bytesPerSecond?: number;
}

export type UploadRunResult =
  | { status: 'completed'; entry: Entry }
  | { status: 'cancelled' }
  | {
      status: 'paused';
      confirmedBytes: number;
      totalBytes: number;
      error?: unknown;
    };
