import type { DownloadProgress, DownloadRequest, DownloadRunResult } from './download-types';
import type {
  ContentChecksum,
  Entry,
  EntryPage,
  EntryRef,
  ListRequest,
  ReadOptions,
} from '@shared/storage';
import type { OperationContext, ReadHandle } from '@main/storage/core/contracts';
import { normalizeStorageError, StorageError, throwIfAborted } from '@main/storage/core/errors';
import { DownloadOutput } from './download-output';
import { downloadDirectory, DownloadError, downloadFailure } from './download-paths';
import { DownloadProgressReporter } from './download-progress-reporter';

export interface DownloadSource {
  stat(ref: EntryRef, context: OperationContext): Promise<Entry>;
  read(ref: EntryRef, options: ReadOptions, context: OperationContext): Promise<ReadHandle>;
  list?(ref: EntryRef, request: ListRequest, context: OperationContext): Promise<EntryPage>;
}

type TransferStage =
  | 'prepared'
  | 'starting'
  | 'downloading'
  | 'paused'
  | 'saving'
  | 'cancelling'
  | 'completed'
  | 'failed'
  | 'cancelled';

/** Owns one session's resumable bytes; the queue decides when each attempt runs. */
export class DownloadTransfer {
  private stage: TransferStage = 'prepared';
  private running: Promise<DownloadRunResult> | undefined;
  private controller = new AbortController();
  private pauseRequested = false;
  private cancellation: Promise<void> | undefined;
  private readonly output: DownloadOutput;
  private readonly checksum: ContentChecksum | undefined;
  private totalBytes: number | undefined;
  private readonly resumable: boolean;

  constructor(
    private readonly source: DownloadSource,
    private readonly request: DownloadRequest,
    private readonly directory: string,
    path: string,
    entry: Entry,
    assertDirectory?: () => Promise<void>,
  ) {
    this.checksum = ['sha256', 'md5'].flatMap(
      (algorithm) => entry.checksums?.filter((checksum) => checksum.algorithm === algorithm) ?? [],
    )[0];
    this.totalBytes = entry.size;
    this.resumable =
      entry.capabilities.rangeRead?.support === 'supported' &&
      this.checksum !== undefined &&
      Number.isSafeInteger(entry.size) &&
      (entry.size ?? -1) >= 0;
    this.output = new DownloadOutput(
      path,
      directory,
      request.replace,
      this.checksum?.algorithm,
      assertDirectory,
    );
  }

  run(
    id: string,
    attempt: string,
    onProgress: (progress: DownloadProgress) => void,
  ): Promise<DownloadRunResult> {
    if (this.stage !== 'prepared' && this.stage !== 'paused')
      throw new StorageError('InvalidArgument');
    const resuming = this.stage === 'paused';
    this.stage = 'starting';
    this.pauseRequested = false;
    this.controller = new AbortController();
    this.running = this.execute(id, attempt, onProgress, resuming);
    return this.running;
  }

  async pause(): Promise<void> {
    if (this.stage === 'paused' || this.pauseRequested) {
      await this.running;
      return;
    }
    if (this.stage !== 'downloading' || !this.resumable) throw new StorageError('InvalidArgument');
    this.pauseRequested = true;
    this.controller.abort();
    await this.running;
  }

  cancel(): Promise<void> {
    this.cancellation ??= this.cancelTransfer();
    return this.cancellation;
  }

  private async cancelTransfer(): Promise<void> {
    if (this.stage === 'saving' || this.stage === 'completed' || this.stage === 'failed') {
      await this.running?.catch(() => {});
      return;
    }
    const active = this.stage === 'starting' || this.stage === 'downloading';
    this.stage = 'cancelling';
    this.pauseRequested = false;
    this.controller.abort();
    if (active) await this.running?.catch(() => {});
    else {
      try {
        await this.output.cleanup(false);
      } catch {
        throw new DownloadError('DownloadCleanupFailed');
      } finally {
        this.stage = 'cancelled';
      }
    }
  }

  private async execute(
    id: string,
    attempt: string,
    onProgress: (progress: DownloadProgress) => void,
    resuming: boolean,
  ): Promise<DownloadRunResult> {
    const signal = this.controller.signal;
    let handle: ReadHandle | undefined;
    let reporter: DownloadProgressReporter | undefined;
    let completed = false;
    let failed = false;
    let failure: unknown;
    try {
      await downloadDirectory(this.directory);
      throwIfAborted(signal);
      if (resuming) await this.verifySource(signal);
      await this.output.open(signal);
      throwIfAborted(signal);
      const offset = this.output.bytes;
      if (!resuming || offset !== this.totalBytes) {
        handle = await this.source.read(this.request.ref, offset > 0 ? { range: { offset } } : {}, {
          signal,
        });
        throwIfAborted(signal);
        if (handle.length !== undefined) {
          const total = offset + handle.length;
          if (this.totalBytes !== undefined && total !== this.totalBytes)
            throw new StorageError('OutcomeUnknown');
          this.totalBytes = total;
        }
        this.stage = 'downloading';
        reporter = new DownloadProgressReporter(
          id,
          this.totalBytes,
          () => this.output.bytes,
          (progress) =>
            onProgress({
              ...progress,
              attempt,
              controls: {
                cancellable: progress.stage !== 'saving',
                pausable: progress.stage === 'downloading' && this.resumable,
              },
            }),
        );
        const chunks: AsyncIterable<unknown> = handle.stream;
        const abort = () => handle?.stream.destroy(new StorageError('Cancelled'));
        signal.addEventListener('abort', abort, { once: true });
        try {
          await this.writeChunks(chunks, signal);
        } finally {
          signal.removeEventListener('abort', abort);
        }
        throwIfAborted(signal);
        if (this.totalBytes !== undefined && this.output.bytes !== this.totalBytes)
          throw new StorageError('OutcomeUnknown');
        await handle.dispose();
        handle = undefined;
      }
      throwIfAborted(signal);
      this.stage = 'saving';
      if (reporter) reporter.saving();
      else {
        try {
          onProgress({
            id,
            attempt,
            controls: { cancellable: false, pausable: false },
            stage: 'saving',
            completedBytes: this.output.bytes,
            ...(this.totalBytes !== undefined ? { totalBytes: this.totalBytes } : {}),
          });
        } catch {
          /* Progress delivery must not interrupt publication. */
        }
      }
      await this.output.verify(signal);
      if (this.checksum && this.output.contentChecksum !== this.checksum.value.toLowerCase())
        throw new StorageError('SourceChanged');
      await this.output.close();
      await this.output.publish();
      completed = true;
    } catch (error) {
      failed = true;
      failure = error;
    }
    reporter?.dispose();
    let cleanupFailed = false;
    try {
      await handle?.dispose();
    } catch {
      cleanupFailed = true;
    }
    try {
      await this.output.close();
    } catch {
      cleanupFailed = true;
    }
    if (
      !cleanupFailed &&
      failed &&
      this.pauseRequested &&
      normalizeStorageError(failure).code === 'Cancelled'
    ) {
      this.stage = 'paused';
      return {
        status: 'paused',
        completedBytes: this.output.bytes,
        ...(this.totalBytes !== undefined ? { totalBytes: this.totalBytes } : {}),
      };
    }
    try {
      await this.output.cleanup(completed);
    } catch {
      cleanupFailed = true;
    }
    this.stage = completed ? 'completed' : 'failed';
    if (cleanupFailed) throw new DownloadError('DownloadCleanupFailed');
    if (failed) {
      if (failure instanceof DownloadError) throw failure;
      downloadFailure(failure);
    }
    return { status: 'completed' };
  }

  private async writeChunks(chunks: AsyncIterable<unknown>, signal: AbortSignal): Promise<void> {
    throwIfAborted(signal);
    for await (const chunk of chunks) {
      throwIfAborted(signal);
      if (!(chunk instanceof Uint8Array)) throw new StorageError('OutcomeUnknown');
      if (this.totalBytes !== undefined && this.output.bytes + chunk.byteLength > this.totalBytes)
        throw new StorageError('OutcomeUnknown');
      await this.output.write(chunk);
    }
  }

  private async verifySource(signal: AbortSignal): Promise<void> {
    const entry = await this.source.stat(this.request.ref, { signal });
    if (
      !this.checksum ||
      entry.kind !== 'file' ||
      entry.size !== this.totalBytes ||
      !entry.checksums?.some(
        (checksum) =>
          checksum.algorithm === this.checksum?.algorithm &&
          checksum.value.toLowerCase() === this.checksum.value.toLowerCase(),
      )
    )
      throw new StorageError('SourceChanged');
  }
}
