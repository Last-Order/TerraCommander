import { TransferRateReporter } from '../transfer-rate-reporter';
import type { DownloadProgress } from './download-types';

/** Samples recent throughput even while the source is stalled. */
export class DownloadProgressReporter {
  private readonly rate: TransferRateReporter;
  private stopped = false;

  constructor(
    private readonly id: string,
    private readonly totalBytes: number | undefined,
    private readonly completedBytes: () => number,
    private readonly onProgress: (progress: Omit<DownloadProgress, 'attempt' | 'controls'>) => void,
  ) {
    this.rate = new TransferRateReporter(this.completedBytes, (bytes, bytesPerSecond) => {
      this.emit({ ...this.snapshot(bytes), stage: 'downloading', bytesPerSecond });
    });
  }

  saving(): void {
    if (this.stopped) return;
    this.dispose();
    this.emit({ ...this.snapshot(), stage: 'saving' });
  }

  dispose(): void {
    this.stopped = true;
    this.rate.dispose();
  }

  private snapshot(completedBytes = this.completedBytes()) {
    return {
      id: this.id,
      completedBytes,
      ...(this.totalBytes !== undefined ? { totalBytes: this.totalBytes } : {}),
    };
  }

  private emit(progress: Omit<DownloadProgress, 'attempt' | 'controls'>): void {
    try {
      this.onProgress(progress);
    } catch {
      /* Progress delivery must not interrupt a transfer or its cleanup. */
    }
  }
}
