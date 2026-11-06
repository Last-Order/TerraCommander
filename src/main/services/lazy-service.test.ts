import { describe, expect, it, vi } from 'vitest';
import { LazyService, ServiceClosedError } from './lazy-service';
import { deferred } from '../testing/deferred';

describe('lazy service lifecycle', () => {
  it('does not create an unused service, including during shutdown', async () => {
    const create = vi.fn(() => ({}));
    const cleanup = vi.fn();
    const service = new LazyService({ create, dispose: cleanup });
    expect(create).not.toHaveBeenCalled();
    const closing = service.dispose();
    expect(service.dispose()).toBe(closing);
    await closing;
    await expect(service.get()).rejects.toBeInstanceOf(ServiceClosedError);
    expect(create).not.toHaveBeenCalled();
    expect(cleanup).not.toHaveBeenCalled();
  });

  it('shares synchronous initialization and retains one instance for later callers', async () => {
    const instance = {};
    const create = vi.fn(() => instance);
    const cleanup = vi.fn();
    const service = new LazyService({ create, dispose: cleanup });
    const first = service.get();
    const second = service.get();
    expect(create).not.toHaveBeenCalled();
    const results = await Promise.all([first, second, service.get()]);
    expect(results.every((value) => value === instance)).toBe(true);
    expect(await service.get()).toBe(instance);
    expect(create).toHaveBeenCalledTimes(1);
    await service.dispose();
    expect(cleanup).toHaveBeenCalledExactlyOnceWith(instance);
  });

  it('does not initialize for an already-cancelled caller', async () => {
    const create = vi.fn(() => ({}));
    const service = new LazyService({ create, dispose: () => undefined });
    const controller = new AbortController();
    controller.abort(new Error('private caller reason'));
    await expect(service.get(controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
    expect(create).not.toHaveBeenCalled();
    await service.dispose();
  });

  it('cancels only one waiter while another caller shares the same initialization', async () => {
    const pending = deferred<object>();
    const create = vi.fn((_signal: AbortSignal) => pending.promise);
    const cleanup = vi.fn();
    const service = new LazyService({ create, dispose: cleanup });
    const controller = new AbortController();
    const first = service.get(controller.signal);
    const rejected = expect(first).rejects.toMatchObject({ name: 'AbortError' });
    const second = service.get();
    await vi.waitFor(() => expect(create).toHaveBeenCalledTimes(1));
    const initializationSignal = create.mock.calls[0]![0];
    expect(initializationSignal).not.toBe(controller.signal);
    controller.abort();
    await rejected;
    expect(initializationSignal.aborted).toBe(false);
    const instance = {};
    pending.resolve(instance);
    expect(await second).toBe(instance);
    await service.dispose();
    expect(cleanup).toHaveBeenCalledExactlyOnceWith(instance);
  });

  it('retains successful initialization even when its only caller cancels', async () => {
    const pending = deferred<object>();
    const create = vi.fn(() => pending.promise);
    const service = new LazyService({ create, dispose: () => undefined });
    const controller = new AbortController();
    const first = service.get(controller.signal);
    const rejected = expect(first).rejects.toMatchObject({ name: 'AbortError' });
    await vi.waitFor(() => expect(create).toHaveBeenCalled());
    controller.abort();
    await rejected;
    const instance = {};
    pending.resolve(instance);
    expect(await service.get()).toBe(instance);
    expect(create).toHaveBeenCalledTimes(1);
    await service.dispose();
  });

  it('shares an initialization failure and allows a later explicit retry', async () => {
    const failure = new Error('The factory could not initialize.');
    const instance = {};
    const create = vi
      .fn<() => Promise<object>>()
      .mockRejectedValueOnce(failure)
      .mockResolvedValue(instance);
    const cleanup = vi.fn();
    const service = new LazyService({ create, dispose: cleanup });
    const first = service.get();
    const second = service.get();
    expect(await Promise.allSettled([first, second])).toEqual([
      { status: 'rejected', reason: failure },
      { status: 'rejected', reason: failure },
    ]);
    expect(create).toHaveBeenCalledTimes(1);
    expect(await service.get()).toBe(instance);
    expect(create).toHaveBeenCalledTimes(2);
    await service.dispose();
    expect(cleanup).toHaveBeenCalledExactlyOnceWith(instance);
  });

  it('skips deferred factory work if shutdown starts immediately after get', async () => {
    const create = vi.fn(() => ({}));
    const service = new LazyService({ create, dispose: () => undefined });
    const first = service.get();
    const rejected = expect(first).rejects.toBeInstanceOf(ServiceClosedError);
    await service.dispose();
    await rejected;
    expect(create).not.toHaveBeenCalled();
  });

  it('rejects waiters on shutdown and disposes a late factory result exactly once', async () => {
    const pending = deferred<object>();
    const create = vi.fn((_signal: AbortSignal) => pending.promise);
    const cleanup = vi.fn();
    const service = new LazyService({ create, dispose: cleanup });
    const first = service.get();
    const rejected = expect(first).rejects.toBeInstanceOf(ServiceClosedError);
    await vi.waitFor(() => expect(create).toHaveBeenCalled());
    const closing = service.dispose();
    expect(service.dispose()).toBe(closing);
    await rejected;
    expect(create.mock.calls[0]![0].aborted).toBe(true);
    expect(cleanup).not.toHaveBeenCalled();
    await expect(service.get()).rejects.toBeInstanceOf(ServiceClosedError);
    const instance = {};
    pending.resolve(instance);
    await closing;
    expect(cleanup).toHaveBeenCalledExactlyOnceWith(instance);
    await expect(service.get()).rejects.toBeInstanceOf(ServiceClosedError);
  });

  it('does not reopen when initialization fails during shutdown', async () => {
    const pending = deferred<object>();
    const create = vi.fn(() => pending.promise);
    const cleanup = vi.fn();
    const service = new LazyService({ create, dispose: cleanup });
    const first = service.get();
    const rejected = expect(first).rejects.toBeInstanceOf(ServiceClosedError);
    await vi.waitFor(() => expect(create).toHaveBeenCalled());
    const closing = service.dispose();
    pending.reject(new Error('late initialization failure'));
    await closing;
    await rejected;
    await expect(service.get()).rejects.toBeInstanceOf(ServiceClosedError);
    expect(create).toHaveBeenCalledTimes(1);
    expect(cleanup).not.toHaveBeenCalled();
  });

  it('stays closed after cleanup fails without running cleanup again', async () => {
    const failure = new Error('cleanup failed');
    const cleanup = vi.fn<() => Promise<void>>().mockRejectedValue(failure);
    const service = new LazyService({ create: () => ({}), dispose: cleanup });
    await service.get();
    const closing = service.dispose();
    await expect(closing).rejects.toBe(failure);
    expect(service.dispose()).toBe(closing);
    await expect(service.dispose()).rejects.toBe(failure);
    await expect(service.get()).rejects.toBeInstanceOf(ServiceClosedError);
    expect(cleanup).toHaveBeenCalledTimes(1);
  });

  it('shares cleanup when an initialization lifetime listener re-enters dispose', async () => {
    let reentered: Promise<void> | undefined;
    const cleanup = vi.fn();
    const service = new LazyService<object>({
      create: (signal) => {
        signal.addEventListener(
          'abort',
          () => {
            reentered = service.dispose();
          },
          { once: true },
        );
        return {};
      },
      dispose: cleanup,
    });
    await service.get();
    const closing = service.dispose();
    expect(reentered).toBe(closing);
    await closing;
    expect(cleanup).toHaveBeenCalledTimes(1);
  });
});
