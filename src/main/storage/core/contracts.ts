import type { Readable } from 'node:stream';
import type {
  ByteRange,
  Entry,
  JsonValue,
  SourceDescriptor,
  UploadProgress,
  WriteTarget,
  DiscardResult,
} from '../../../shared/storage/models';

export interface OperationProgress {
  /** Includes work that may still be in flight or need to be repeated. */
  processedBytes: number;
  /** Only backend acknowledgements can contribute to a recovery checkpoint. */
  confirmedBytes?: number;
  totalBytes?: number;
}

export interface OperationContext {
  signal?: AbortSignal;
  correlationId?: string;
  onProgress?: (progress: OperationProgress) => void;
}

export interface ReadHandle {
  stream: Readable;
  length?: number;
  revision?: string;
  /** Required when abandoning a read before EOF, including a handle never consumed. */
  dispose(): Promise<void>;
}

interface SourceBase {
  size?: number;
  open(range: ByteRange | undefined, ctx: OperationContext): Promise<ReadHandle>;
}

export interface StreamingByteSource extends SourceBase {
  /** Once an open is attempted, the same source cannot be retried or range-read. */
  kind: 'one-shot';
}

export interface ReopenableByteSource extends SourceBase {
  kind: 'reopenable';
  descriptor: SourceDescriptor;
  /** Proves unchanged bytes when the descriptor alone supplies only weak metadata. */
  verify?(expected: SourceDescriptor, ctx: OperationContext): Promise<boolean>;
}

export type ByteSource = StreamingByteSource | ReopenableByteSource;

export interface DriverCheckpoint {
  /** Driver payload version; independent of the common persisted-envelope version. */
  version: number;
  /** Backend-only state. It may contain secret session URLs and must not reach IPC or logs. */
  payload: JsonValue;
}

interface UploadObservationBase {
  checkpoint: DriverCheckpoint;
  progress: UploadProgress;
}

interface IncompleteUploadObservation extends UploadObservationBase {
  state: 'suspended' | 'unknown' | 'expired';
}

interface CompletedUploadObservation extends UploadObservationBase {
  state: 'completed';
  entry: Entry;
}

export type UploadObservation = IncompleteUploadObservation | CompletedUploadObservation;

export interface UploadHooks {
  /** Resolve only after the checkpoint is durably saved; drivers must await this call. */
  checkpoint(checkpoint: DriverCheckpoint, progress: UploadProgress): Promise<void>;
}

export interface UploadDriver {
  /** Validates this driver's private payload without exposing its validation details. */
  validate(checkpoint: DriverCheckpoint): boolean;
  /** Creates a session only. Sending content must wait for the common checkpoint save. */
  create(
    target: WriteTarget,
    source: SourceDescriptor,
    ctx: OperationContext,
  ): Promise<DriverCheckpoint>;
  /** Queries authoritative backend state, including completion hidden by a lost response. */
  reconcile(checkpoint: DriverCheckpoint, ctx: OperationContext): Promise<UploadObservation>;
  /** Must await every checkpoint hook and cooperate with cancellation. */
  run(
    checkpoint: DriverCheckpoint,
    source: ReopenableByteSource,
    hooks: UploadHooks,
    ctx: OperationContext,
  ): Promise<Entry>;
  /** Cleans unfinished session data only; it must never delete a published file. */
  discard(checkpoint: DriverCheckpoint, ctx: OperationContext): Promise<DiscardResult>;
}
