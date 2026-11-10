import type { BrowserResult } from '../../../shared/storage-browser';

export function success<T>(value: T): BrowserResult<T> {
  return { ok: true, value };
}

export function pausePage<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((finish) => {
    resolve = finish;
  });
  return { promise, resolve };
}
