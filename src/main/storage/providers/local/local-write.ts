import { createHash, type Hash } from 'node:crypto';
import type { BigIntStats } from 'node:fs';
import { lstat, mkdtemp, open, rename, rm, unlink, type FileHandle } from 'node:fs/promises';
import { join } from 'node:path';
import { AccountError } from '@main/accounts/core/errors';
import type {
  AdapterWriteSession,
  ByteSource,
  OperationContext,
  ReopenableByteSource,
  SessionWriteContext,
} from '@main/storage/core/contracts';
import { normalizeStorageError, StorageError, throwIfAborted } from '@main/storage/core/errors';
import type { ContentChecksum, Entry, EntryRef } from '@shared/storage';
import type { LocalDirectoryScope } from './local-directory-scope';

const verifyBufferSize = 1024 * 1024;

function sameFile(current: BigIntStats | undefined, expected: BigIntStats | undefined): boolean {
  return (
    current !== undefined &&
    expected !== undefined &&
    current.isFile() &&
    current.dev === expected.dev &&
    current.ino === expected.ino
  );
}

async function fileIdentity(path: string): Promise<BigIntStats | undefined> {
  return lstat(path, { bigint: true }).catch((error: unknown) => {
    if (
      error &&
      typeof error === 'object' &&
      'code' in error &&
      (error.code === 'ENOENT' || error.code === 'ENOTDIR')
    ) {
      return undefined;
    }
    throw error;
  });
}

async function checkWriteTarget(
  path: string,
  replace: boolean,
  mapError: (error: unknown, signal?: AbortSignal) => never,
  signal?: AbortSignal,
): Promise<void> {
  const existing = await lstat(path, { bigint: true }).catch((error: unknown) => {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
      return undefined;
    }
    mapError(error, signal);
  });
  if (existing && !existing.isFile()) throw new StorageError('InvalidArgument');
  if (existing && !replace) throw new StorageError('AlreadyExists');
}

function isRetryableSourceFailure(error: unknown): boolean {
  if (error instanceof AccountError) return error.code === 'AuthRequired';
  const storage = normalizeStorageError(error);
  return (
    storage.retryHint === 'safe' ||
    storage.code === 'NetworkError' ||
    storage.code === 'RateLimited' ||
    storage.code === 'AuthRequired'
  );
}

/** Owns the partial or temporary file and verifies ownership + integrity before resuming or publishing. */
class LocalWriteOutput {
  private completedBytes = 0;
  private handle: FileHandle | undefined;
  private temporary: string | undefined;
  private identity: BigIntStats | undefined;
  private created = false;
  private ownershipLost = false;
  private readonly digest = createHash('sha256');
  private readonly contentDigest: Hash | undefined;

  constructor(
    readonly path: string,
    private readonly directory: string,
    private readonly replace: boolean,
    checksumAlgorithm: string | undefined,
    private readonly directoryScope: LocalDirectoryScope | undefined,
    private readonly mapError: (error: unknown, signal?: AbortSignal) => never,
  ) {
    this.contentDigest = checksumAlgorithm ? createHash(checksumAlgorithm) : undefined;
  }

  get bytes(): number {
    return this.completedBytes;
  }

  get isCreated(): boolean {
    return this.created;
  }

  get contentChecksum(): string | undefined {
    return this.contentDigest?.copy().digest('hex');
  }

  private get outputPath(): string {
    return this.temporary ? join(this.temporary, 'content') : this.path;
  }

  async open(signal?: AbortSignal): Promise<void> {
    await this.directoryScope?.assertDirectoryPath(this.directory, signal);
    try {
      if (this.created) {
        await this.assertOwned();
        this.handle = await open(this.outputPath, 'r+');
        await this.verify(signal);
        return;
      }
      if (this.replace) {
        await checkWriteTarget(this.path, true, this.mapError, signal);
        this.temporary = await mkdtemp(join(this.directory, '.terra-transfer-'));
      }
      this.handle = await open(this.outputPath, 'wx+', 0o600);
      this.created = true;
      this.identity = await this.handle.stat({ bigint: true });
    } catch (error) {
      this.mapError(error, signal);
    }
  }

  async write(chunk: Uint8Array): Promise<void> {
    if (!this.handle) throw new StorageError('InvalidArgument');
    let offset = 0;
    while (offset < chunk.byteLength) {
      const { bytesWritten } = await this.handle.write(
        chunk,
        offset,
        chunk.byteLength - offset,
        this.completedBytes,
      );
      if (bytesWritten <= 0) throw new StorageError('OutcomeUnknown');
      const written = chunk.subarray(offset, offset + bytesWritten);
      this.digest.update(written);
      this.contentDigest?.update(written);
      this.completedBytes += bytesWritten;
      offset += bytesWritten;
    }
  }

  async verify(signal?: AbortSignal): Promise<void> {
    if (!this.handle) throw new StorageError('InvalidArgument');
    await this.assertOwned();
    const before = await this.handle.stat({ bigint: true });
    if (!sameFile(before, this.identity) || before.size !== BigInt(this.completedBytes)) {
      this.lostOwnership();
    }
    const digest = createHash('sha256');
    const buffer = Buffer.alloc(verifyBufferSize);
    let offset = 0;
    while (offset < this.completedBytes) {
      throwIfAborted(signal);
      const { bytesRead } = await this.handle.read(
        buffer,
        0,
        Math.min(buffer.length, this.completedBytes - offset),
        offset,
      );
      if (bytesRead === 0) this.lostOwnership();
      digest.update(buffer.subarray(0, bytesRead));
      offset += bytesRead;
    }
    const after = await this.handle.stat({ bigint: true });
    if (
      after.size !== before.size ||
      after.mtimeNs !== before.mtimeNs ||
      after.ctimeNs !== before.ctimeNs ||
      digest.digest('hex') !== this.digest.copy().digest('hex')
    ) {
      this.lostOwnership();
    }
    await this.assertOwned();
  }

  async close(): Promise<void> {
    const handle = this.handle;
    this.handle = undefined;
    if (!handle) return;
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  }

  async publish(signal?: AbortSignal): Promise<void> {
    await this.directoryScope?.assertDirectoryPath(this.directory, signal);
    await this.assertOwned();
    if (this.temporary) {
      await checkWriteTarget(this.path, true, this.mapError, signal);
      try {
        await rename(this.outputPath, this.path);
      } catch (error) {
        this.mapError(error, signal);
      }
    }
  }

  async cleanup(completed: boolean, signal?: AbortSignal): Promise<void> {
    if (this.temporary || (!completed && this.created)) {
      await this.directoryScope?.assertDirectoryPath(this.directory, signal);
    }
    if (this.temporary) {
      const dir = this.temporary;
      this.temporary = undefined;
      await rm(dir, { recursive: true, force: true });
    } else if (!completed && this.created && !this.ownershipLost) {
      if (!this.identity) throw new StorageError('OutcomeUnknown');
      if (sameFile(await fileIdentity(this.path), this.identity)) {
        await unlink(this.path);
      }
      this.created = false;
    }
  }

  private async assertOwned(): Promise<void> {
    if (!sameFile(await fileIdentity(this.outputPath), this.identity)) {
      this.lostOwnership();
    }
  }

  private lostOwnership(): never {
    this.ownershipLost = true;
    throw new StorageError('PreconditionFailed');
  }
}

export interface LocalWriteSpec {
  readonly parentPath: string;
  readonly targetPath: string;
  readonly targetRef: EntryRef;
  readonly replace: boolean;
  readonly directoryScope?: LocalDirectoryScope | undefined;
  readonly statTarget: (ref: EntryRef, signal?: AbortSignal) => Promise<Entry>;
  readonly mapError: (error: unknown, signal?: AbortSignal) => never;
}

function combineSignals(
  signal: AbortSignal | undefined,
  pauseSignal: AbortSignal | undefined,
): AbortSignal | undefined {
  if (signal && pauseSignal) return AbortSignal.any([signal, pauseSignal]);
  return pauseSignal ?? signal;
}

async function copyStreamToOutput(
  output: LocalWriteOutput,
  source: ByteSource,
  offset: number,
  expectedTotal: number | undefined,
  signal: AbortSignal | undefined,
  onBytesSent?: (count: number) => void,
  onProgress?: OperationContext['onProgress'],
): Promise<number | undefined> {
  const handle = await source.open(offset > 0 ? { offset } : undefined, signal ? { signal } : {});
  const abortStream = () => handle.stream.destroy(new StorageError('Cancelled'));
  signal?.addEventListener('abort', abortStream, { once: true });
  let totalBytes = expectedTotal;
  try {
    throwIfAborted(signal);
    if (handle.length !== undefined) {
      const total = offset + handle.length;
      if (totalBytes !== undefined && total !== totalBytes) {
        throw new StorageError('OutcomeUnknown');
      }
      totalBytes = total;
    }
    for await (const chunk of handle.stream) {
      throwIfAborted(signal);
      if (!(chunk instanceof Uint8Array)) throw new StorageError('OutcomeUnknown');
      if (totalBytes !== undefined && output.bytes + chunk.byteLength > totalBytes) {
        throw new StorageError('OutcomeUnknown');
      }
      await output.write(chunk);
      onBytesSent?.(chunk.byteLength);
      onProgress?.({
        processedBytes: output.bytes,
        confirmedBytes: output.bytes,
        ...(totalBytes !== undefined ? { totalBytes } : {}),
      });
    }
    throwIfAborted(signal);
    if (totalBytes !== undefined && output.bytes !== totalBytes) {
      throw new StorageError('OutcomeUnknown');
    }
    return totalBytes;
  } finally {
    signal?.removeEventListener('abort', abortStream);
    await handle.dispose().catch(() => {});
  }
}

export function createLocalWriteSession(
  spec: LocalWriteSpec,
  expectedSize: number | undefined,
  checksum: ContentChecksum | undefined,
): AdapterWriteSession {
  const output = new LocalWriteOutput(
    spec.targetPath,
    spec.parentPath,
    spec.replace,
    checksum?.algorithm,
    spec.directoryScope,
    spec.mapError,
  );
  let totalBytes = expectedSize;
  let discarded = false;

  async function safeClose(): Promise<boolean> {
    try {
      await output.close();
      return false;
    } catch {
      return true;
    }
  }

  async function safeCleanup(completed: boolean, signal?: AbortSignal): Promise<boolean> {
    try {
      await output.cleanup(completed, signal);
      return false;
    } catch {
      return true;
    }
  }

  return {
    async run(source: ReopenableByteSource, context: SessionWriteContext): Promise<Entry> {
      if (discarded) throw new StorageError('PreconditionFailed');
      const { signal, pauseSignal, onBytesSent, onProgress, onStageChange } = context;
      const transferSignal = combineSignals(signal, pauseSignal);
      const resuming = output.isCreated;
      let finalizing = false;
      let completed = false;
      let failure: unknown;

      try {
        throwIfAborted(transferSignal);
        // Always assert target directory & local partial file integrity before touching the source.
        await spec.directoryScope?.assertDirectoryPath(spec.parentPath, transferSignal);
        await output.open(transferSignal);
        if (resuming && source.verify) {
          const valid = await source.verify(
            source.descriptor,
            transferSignal ? { signal: transferSignal } : {},
          );
          if (!valid) throw new StorageError('SourceChanged');
        }
        throwIfAborted(transferSignal);

        if (!resuming || totalBytes === undefined || output.bytes !== totalBytes) {
          onStageChange?.('transferring');
          totalBytes = await copyStreamToOutput(
            output,
            source,
            output.bytes,
            totalBytes,
            transferSignal,
            onBytesSent,
            onProgress,
          );
        }

        throwIfAborted(transferSignal);
        finalizing = true;
        onStageChange?.('finalizing');
        await output.verify(signal);
        if (checksum && output.contentChecksum !== checksum.value.toLowerCase()) {
          throw new StorageError('SourceChanged');
        }
        await output.close();
        await output.publish(signal);
        completed = true;
      } catch (error) {
        failure = error;
      }

      const closeFailed = await safeClose();
      if (!completed && !closeFailed && !finalizing) {
        const pausedByControl =
          Boolean(pauseSignal?.aborted && !signal?.aborted) &&
          normalizeStorageError(failure).code === 'Cancelled';
        const pausedByRetryable = !signal?.aborted && isRetryableSourceFailure(failure);
        if (pausedByControl || pausedByRetryable) {
          throw failure;
        }
      }

      const cleanupFailed = await safeCleanup(completed);
      if (closeFailed || cleanupFailed) {
        throw new StorageError('OutcomeUnknown', failure !== undefined ? { cause: failure } : {});
      }
      if (!completed) {
        throw failure;
      }
      return spec.statTarget(spec.targetRef, signal);
    },

    async discard(context?: OperationContext): Promise<void> {
      if (discarded) return;
      discarded = true;
      const closeFailed = await safeClose();
      const cleanupFailed = await safeCleanup(false, context?.signal);
      if (closeFailed || cleanupFailed) {
        throw new StorageError('OutcomeUnknown');
      }
    },
  };
}

export async function writeLocalFile(
  spec: LocalWriteSpec,
  source: ByteSource,
  context: OperationContext,
): Promise<Entry> {
  if (source.kind === 'reopenable') {
    const session = createLocalWriteSession(
      spec,
      source.descriptor.size,
      source.descriptor.checksum,
    );
    return session.run(source, context);
  }
  const output = new LocalWriteOutput(
    spec.targetPath,
    spec.parentPath,
    spec.replace,
    undefined,
    spec.directoryScope,
    spec.mapError,
  );
  let completed = false;
  let failure: unknown;

  try {
    throwIfAborted(context.signal);
    await spec.directoryScope?.assertDirectoryPath(spec.parentPath, context.signal);
    await output.open(context.signal);
    throwIfAborted(context.signal);
    await copyStreamToOutput(
      output,
      source,
      0,
      source.size,
      context.signal,
      undefined,
      context.onProgress,
    );
    await output.verify(context.signal);
    await output.close();
    await output.publish(context.signal);
    completed = true;
  } catch (error) {
    failure = error;
  }

  const closeFailed = await output
    .close()
    .then(() => false)
    .catch(() => true);
  const cleanupFailed = await output
    .cleanup(completed)
    .then(() => false)
    .catch(() => true);
  if (closeFailed || cleanupFailed) {
    throw new StorageError('OutcomeUnknown', failure !== undefined ? { cause: failure } : {});
  }
  if (!completed) throw failure;
  return spec.statTarget(spec.targetRef, context.signal);
}
