import type { Entry } from '@shared/storage';
import { AccountError } from '@main/accounts/core/errors';
import { normalizeStorageError, type WriteExecution } from '@main/storage';
import type { TaskContext, TaskExecutionOutcome } from '@main/tasks/types';
import { TransferRateReporter } from '../transfer-rate-reporter';

export class UploadTransfer {
  private execution: WriteExecution | undefined;
  private pauseController: AbortController | undefined;
  private confirmed = 0;
  retryable = false;

  constructor(
    private readonly total: number,
    private readonly prepare: () => WriteExecution,
  ) {}

  async run(context: TaskContext): Promise<TaskExecutionOutcome<Entry>> {
    const pause = new AbortController();
    this.pauseController = pause;
    this.retryable = false;
    let sent = 0;
    let rate = 0;
    let paused = false;
    const report = (bytesPerSecond?: number) => {
      const stage = { key: 'storage:uploadSending' };
      const speed = bytesPerSecond === undefined ? {} : { bytesPerSecond };
      context.reportProgress(
        this.total === 0
          ? { kind: 'indeterminate', stage, ...speed }
          : {
              kind: 'determinate',
              completed: this.confirmed,
              total: this.total,
              unit: 'bytes',
              stage,
              ...speed,
            },
      );
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
      context.reportControls({ cancellable: true, pausable: true });
      const result = await this.execution.run({
        signal: context.signal,
        pauseSignal: pause.signal,
        onBytesSent: (count) => {
          sent += count;
        },
        onProgress: ({ confirmedBytes }) => {
          this.confirmed = confirmedBytes ?? this.confirmed;
          report(rate);
        },
      });
      return { status: 'completed', result };
    } catch (error) {
      const failure = normalizeStorageError(error);
      const code = error instanceof AccountError ? error.code : failure.code;
      if (code === 'Cancelled') {
        paused = pause.signal.aborted && !context.signal.aborted;
        if (!paused) return { status: 'cancelled' };
        report();
        return { status: 'paused' };
      }
      this.retryable = failure.retryHint === 'safe';
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
