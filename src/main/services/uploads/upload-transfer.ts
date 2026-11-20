import { AccountError } from '@main/accounts/core/errors';
import { normalizeStorageError, type WriteExecution } from '@main/storage';
import { TransferRateReporter } from '../transfer-rate-reporter';
import type { UploadProgress, UploadRunResult } from './upload-types';

export interface UploadRunOptions {
  signal: AbortSignal;
  onProgress: (progress: UploadProgress) => void;
}

export class UploadTransfer {
  private execution: WriteExecution | undefined;
  private pauseController: AbortController | undefined;
  private confirmed = 0;
  retryable = false;

  constructor(
    private readonly total: number,
    private readonly prepare: () => WriteExecution,
  ) {}

  async run({ signal, onProgress }: UploadRunOptions): Promise<UploadRunResult> {
    const pause = new AbortController();
    this.pauseController = pause;
    this.retryable = false;
    let sent = 0;
    let rate = 0;
    let paused = false;
    const controls = { cancellable: true, pausable: true };
    const report = (bytesPerSecond?: number) => {
      onProgress({
        controls,
        stage: 'sending',
        confirmedBytes: this.confirmed,
        totalBytes: this.total,
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
      this.execution ??= this.prepare();
      report();
      const entry = await this.execution.run({
        signal,
        pauseSignal: pause.signal,
        onBytesSent: (count) => {
          sent += count;
        },
        onProgress: ({ confirmedBytes }) => {
          this.confirmed = confirmedBytes ?? this.confirmed;
          report(rate);
        },
      });
      return { status: 'completed', entry };
    } catch (error) {
      const failure = normalizeStorageError(error);
      const code = error instanceof AccountError ? error.code : failure.code;
      if (code === 'Cancelled') {
        paused = pause.signal.aborted && !signal.aborted;
        if (!paused) return { status: 'cancelled' };
        report();
        return { status: 'paused', confirmedBytes: this.confirmed, totalBytes: this.total };
      }
      const retryable =
        failure.retryHint === 'safe' || (error instanceof AccountError && code === 'AuthRequired');
      if (retryable && this.execution) {
        paused = true;
        report();
        return { status: 'paused', confirmedBytes: this.confirmed, totalBytes: this.total, error };
      }
      this.retryable = retryable;
      throw error;
    } finally {
      reporter.dispose();
      this.pauseController = undefined;
      if (!paused) this.release();
    }
  }

  pause(): void {
    this.pauseController?.abort();
  }

  cancel(): void {
    if (!this.pauseController) this.release();
  }

  private release(): void {
    this.execution = undefined;
    this.confirmed = 0;
  }
}
