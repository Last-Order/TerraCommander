import type { DownloadProgress } from './download-types';

/** Samples recent throughput even while the source is stalled. */
export class DownloadProgressReporter {
  private readonly samples: { time: number; bytes: number }[] = [];
  private readonly timer: ReturnType<typeof setInterval>;
  private stopped = false;

  constructor(
    private readonly id: string,
    private readonly totalBytes: number | undefined,
    private readonly completedBytes: () => number,
    private readonly onProgress: (progress: Omit<DownloadProgress, 'attempt' | 'controls'>) => void,
  ) {
    this.timer = setInterval(() => this.downloading(), 500);
    this.timer.unref();
    this.downloading();
  }

  saving(): void {
    if (this.stopped) return;
    this.dispose();
    this.emit({ ...this.snapshot(), stage: 'saving' });
  }

  dispose(): void {
    this.stopped = true;
    clearInterval(this.timer);
  }

  private snapshot() {
    return {
      id: this.id,
      completedBytes: this.completedBytes(),
      ...(this.totalBytes !== undefined ? { totalBytes: this.totalBytes } : {}),
    };
  }

  private downloading(): void {
    if (this.stopped) return;
    const time = performance.now();
    const snapshot = this.snapshot();
    this.samples.push({ time, bytes: snapshot.completedBytes });
    while (this.samples.length > 2 && (this.samples[1]?.time ?? Infinity) <= time - 2000)
      this.samples.shift();
    const first = this.samples[0];
    const bytesPerSecond =
      first && time > first.time
        ? Math.max(0, ((snapshot.completedBytes - first.bytes) * 1000) / (time - first.time))
        : 0;
    this.emit({ ...snapshot, stage: 'downloading', bytesPerSecond });
  }

  private emit(progress: Omit<DownloadProgress, 'attempt' | 'controls'>): void {
    try {
      this.onProgress(progress);
    } catch {
      /* Progress delivery must not interrupt a transfer or its cleanup. */
    }
  }
}
