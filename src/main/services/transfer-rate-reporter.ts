/** Samples a running byte count, including periods when the transfer stalls. */
export class TransferRateReporter {
  private readonly samples: { time: number; bytes: number }[] = [];
  private readonly timer: ReturnType<typeof setInterval>;

  constructor(readBytes: () => number, onSample: (bytes: number, bytesPerSecond: number) => void) {
    const sample = () => {
      const time = performance.now();
      const bytes = readBytes();
      this.samples.push({ time, bytes });
      while (this.samples.length > 2 && (this.samples[1]?.time ?? Infinity) <= time - 2000)
        this.samples.shift();
      const first = this.samples[0];
      const rate =
        first && time > first.time
          ? Math.max(0, ((bytes - first.bytes) * 1000) / (time - first.time))
          : 0;
      try {
        onSample(bytes, rate);
      } catch {
        /* Progress delivery must not interrupt a transfer or its cleanup. */
      }
    };
    this.timer = setInterval(sample, 500);
    this.timer.unref();
    sample();
  }

  dispose(): void {
    clearInterval(this.timer);
  }
}
