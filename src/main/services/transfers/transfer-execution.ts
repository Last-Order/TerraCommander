import { AccountError } from '@main/accounts/core/errors';
import {
  normalizeStorageError,
  StorageError,
  type ByteSource,
  type DirectoryScope,
  type OperationContext,
  type WriteExecution,
} from '@main/storage';
import type { ContentChecksum, Entry } from '@shared/storage';
import type { StorageDirectory } from '../storage/storage-directory';
import type { FileReplacementPolicy, StorageFile } from '../storage/storage-file';
import { TransferRateReporter } from '../transfer-rate-reporter';
import type { TransferWriteStrategy } from './transfer-compatibility';
import type {
  TransferProgress,
  TransferRunResult,
  TransferSourceSnapshot,
  TransferStage,
} from './transfer-types';

export interface TransferExecutionOptions {
  signal: AbortSignal;
  onProgress: (progress: TransferProgress) => void;
}

export type TransferDestination =
  | { readonly kind: 'create'; readonly directory: StorageDirectory; readonly name: string }
  | {
      readonly kind: 'replace';
      readonly file: StorageFile;
      readonly policy: FileReplacementPolicy;
    };

export interface TransferExecutionSpec {
  readonly destination: TransferDestination;
  readonly directoryScope?: DirectoryScope | undefined;
  readonly source: ByteSource;
  readonly sourceSnapshot: TransferSourceSnapshot;
  readonly strategy: TransferWriteStrategy;
  readonly pausable: boolean;
  readonly checksum?: ContentChecksum | undefined;
}

function isRetryableTransferFailure(error: unknown): boolean {
  if (error instanceof AccountError) return error.code === 'AuthRequired';
  const failure = normalizeStorageError(error);
  return (
    failure.retryHint === 'safe' ||
    failure.code === 'NetworkError' ||
    failure.code === 'RateLimited' ||
    failure.code === 'AuthRequired'
  );
}

function verifyDestinationEntry(
  entry: Entry,
  expectedSize: number | undefined,
  expectedChecksum: ContentChecksum | undefined,
): void {
  if (expectedSize !== undefined && entry.size !== undefined && entry.size !== expectedSize) {
    throw new StorageError('OutcomeUnknown');
  }
  if (expectedChecksum && entry.checksums && entry.checksums.length > 0) {
    const match = entry.checksums.find((item) => item.algorithm === expectedChecksum.algorithm);
    if (match && match.value.toLowerCase() !== expectedChecksum.value.toLowerCase()) {
      throw new StorageError('SourceChanged');
    }
  }
}

/** Owns one file transfer's session execution, cooperative pause/resume, rate reporting, and cleanup. */
export class TransferExecution {
  private execution: WriteExecution | undefined;
  private pauseController: AbortController | undefined;
  private confirmedBytes = 0;
  private stage: TransferStage = 'transferring';
  private active = false;
  retryable = false;

  constructor(private readonly spec: TransferExecutionSpec) {}

  async run({ signal, onProgress }: TransferExecutionOptions): Promise<TransferRunResult> {
    const pause = new AbortController();
    this.pauseController = pause;
    this.retryable = false;
    this.stage = 'transferring';
    this.active = true;

    let sent = 0;
    let rate = 0;
    let paused = false;
    const totalBytes = this.spec.sourceSnapshot.size;

    const isFinalizing = () => this.stage === 'finalizing';
    const report = (bytesPerSecond?: number) => {
      onProgress({
        controls: {
          cancellable: !isFinalizing(),
          pausable: this.spec.pausable && !isFinalizing(),
        },
        stage: this.stage,
        completedBytes: this.confirmedBytes,
        ...(totalBytes !== undefined ? { totalBytes } : {}),
        ...(bytesPerSecond !== undefined ? { bytesPerSecond } : {}),
      });
    };

    const reporter = new TransferRateReporter(
      () => sent,
      (_bytes, bytesPerSecond) => {
        rate = bytesPerSecond;
        report(rate);
      },
    );

    try {
      report();
      const entry = await this.executeWrite(signal, pause.signal, {
        onBytesSent: (count) => {
          sent += count;
        },
        onConfirmed: (confirmed) => {
          this.confirmedBytes = confirmed;
          report(rate);
        },
        onStage: (nextStage) => {
          this.stage = nextStage;
          report(nextStage === 'finalizing' ? undefined : rate);
        },
      });
      verifyDestinationEntry(entry, totalBytes, this.spec.checksum);
      return {
        status: 'completed',
        entry,
        sourceSnapshot: this.spec.sourceSnapshot,
      };
    } catch (error) {
      const failure = normalizeStorageError(error);
      const code = error instanceof AccountError ? error.code : failure.code;
      if (code === 'Cancelled') {
        paused = this.spec.pausable && !isFinalizing() && pause.signal.aborted && !signal.aborted;
        if (!paused) {
          await this.discardSession();
          return { status: 'cancelled' };
        }
        report();
        return {
          status: 'paused',
          completedBytes: this.confirmedBytes,
          ...(totalBytes !== undefined ? { totalBytes } : {}),
        };
      }
      const retryable = isRetryableTransferFailure(error);
      if (retryable && this.spec.pausable && !isFinalizing() && this.execution) {
        paused = true;
        report();
        return {
          status: 'paused',
          completedBytes: this.confirmedBytes,
          ...(totalBytes !== undefined ? { totalBytes } : {}),
          error,
        };
      }
      this.retryable = retryable;
      await this.discardSession();
      throw error;
    } finally {
      reporter.dispose();
      this.pauseController = undefined;
      this.active = false;
      if (!paused) this.reset();
    }
  }

  pause(): void {
    if (!this.spec.pausable || this.stage === 'finalizing') return;
    this.pauseController?.abort();
  }

  async cancel(): Promise<void> {
    if (!this.active) {
      await this.discardSession();
      this.reset();
    }
  }

  private async executeWrite(
    signal: AbortSignal,
    pauseSignal: AbortSignal,
    hooks: {
      onBytesSent: (count: number) => void;
      onConfirmed: (bytes: number) => void;
      onStage: (stage: TransferStage) => void;
    },
  ): Promise<Entry> {
    const { destination, directoryScope, source, strategy } = this.spec;
    const writeOptions = directoryScope ? { directoryScope } : undefined;

    if (strategy === 'one-shot-write' || source.kind !== 'reopenable') {
      let lastBytes = 0;
      const context: OperationContext = {
        signal,
        onProgress: ({ confirmedBytes, processedBytes }) => {
          const bytes = confirmedBytes ?? processedBytes;
          if (bytes > lastBytes) {
            hooks.onBytesSent(bytes - lastBytes);
            lastBytes = bytes;
          }
          hooks.onConfirmed(bytes);
        },
      };
      return destination.kind === 'create'
        ? destination.directory.createFile(destination.name, source, context, writeOptions)
        : destination.file.replaceContents(source, destination.policy, context, writeOptions);
    }

    this.execution ??=
      destination.kind === 'create'
        ? destination.directory.prepareCreateFile(destination.name, source, writeOptions)
        : destination.file.prepareReplaceContents(source, destination.policy, writeOptions);
    return this.execution.run({
      signal,
      ...(this.spec.pausable ? { pauseSignal } : {}),
      onBytesSent: hooks.onBytesSent,
      onProgress: ({ confirmedBytes }) => {
        hooks.onConfirmed(confirmedBytes ?? this.confirmedBytes);
      },
      onStageChange: hooks.onStage,
    });
  }

  private async discardSession(): Promise<void> {
    const current = this.execution;
    this.execution = undefined;
    if (current?.discard) {
      await current.discard().catch(() => {});
    }
  }

  private reset(): void {
    this.execution = undefined;
    this.confirmedBytes = 0;
  }
}
