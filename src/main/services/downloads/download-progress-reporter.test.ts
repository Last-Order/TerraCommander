import { afterEach, expect, it, vi } from 'vitest';
import { DownloadProgressReporter } from './download-progress-reporter';

afterEach(() => vi.useRealTimers());

it('reports recent throughput and falls to zero when the source stalls', () => {
  vi.useFakeTimers();
  const mebibyte = 1024 ** 2;
  let bytes = 0;
  const progress = vi.fn();
  const reporter = new DownloadProgressReporter('download', 20 * mebibyte, () => bytes, progress);
  expect(progress).toHaveBeenLastCalledWith(expect.objectContaining({ bytesPerSecond: 0 }));
  bytes = mebibyte;
  vi.advanceTimersByTime(1000);
  expect(progress).toHaveBeenLastCalledWith(expect.objectContaining({ bytesPerSecond: mebibyte }));
  bytes = 3 * mebibyte;
  vi.advanceTimersByTime(1000);
  bytes = 7 * mebibyte;
  vi.advanceTimersByTime(1000);
  const latest = progress.mock.lastCall?.[0];
  expect(latest?.bytesPerSecond).toBeGreaterThan((7 * mebibyte) / 3);
  expect(latest?.bytesPerSecond).toBeLessThanOrEqual(4 * mebibyte);
  vi.advanceTimersByTime(10_000);
  expect(progress).toHaveBeenLastCalledWith(expect.objectContaining({ bytesPerSecond: 0 }));
  reporter.dispose();
  const count = progress.mock.calls.length;
  vi.advanceTimersByTime(1000);
  expect(progress).toHaveBeenCalledTimes(count);
});

it('preserves unknown totals and ends rate sampling before publication', () => {
  vi.useFakeTimers();
  let bytes = 0;
  const progress = vi.fn();
  const reporter = new DownloadProgressReporter('download', undefined, () => bytes, progress);
  bytes = 256;
  vi.advanceTimersByTime(1000);
  expect(progress).toHaveBeenLastCalledWith({
    id: 'download',
    stage: 'downloading',
    completedBytes: 256,
    bytesPerSecond: 256,
  });
  reporter.saving();
  expect(progress).toHaveBeenLastCalledWith({
    id: 'download',
    stage: 'saving',
    completedBytes: 256,
  });
  const count = progress.mock.calls.length;
  vi.advanceTimersByTime(2000);
  reporter.dispose();
  expect(progress).toHaveBeenCalledTimes(count);
});
