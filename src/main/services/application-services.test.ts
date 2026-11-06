import { describe, expect, it, vi } from 'vitest';
import { FakeAccountCipher, MemoryAccountStore } from '../accounts/testing/fixtures';
import { deferred } from '../testing/deferred';
import { createAccountServices } from '../accounts/runtime/account-services';
import { ApplicationServices } from './application-services';
import { ServiceClosedError } from './lazy-service';

vi.mock('../accounts/runtime/desktop-accounts', () => {
  throw new Error('The real account runtime must not load during host construction or shutdown.');
});

function runtimeModule() {
  const cleanup = vi.fn<() => Promise<void>>();
  const create = vi.fn(() => {
    const fixture = createAccountServices({
      store: new MemoryAccountStore(),
      cipher: new FakeAccountCipher(),
    });
    cleanup.mockImplementation(fixture.dispose);
    vi.spyOn(fixture, 'dispose').mockImplementation(cleanup);
    return fixture;
  });
  return { createDesktopAccountServices: create, cleanup };
}

describe('application service ownership', () => {
  it('constructs and shuts down without loading the real integration or waiting for Electron', async () => {
    const whenReady = vi.fn(async () => undefined);
    const owner = new ApplicationServices({ whenReady });
    expect(whenReady).not.toHaveBeenCalled();
    const closing = owner.dispose();
    expect(owner.dispose()).toBe(closing);
    await closing;
    expect(whenReady).not.toHaveBeenCalled();
    await expect(owner.accounts.get()).rejects.toBeInstanceOf(ServiceClosedError);
  });

  it('opens the account runtime after Electron is ready and disposes it with the host', async () => {
    const ready = deferred<void>();
    const module = runtimeModule();
    const loadAccounts = vi.fn(async () => module);
    const owner = new ApplicationServices({ whenReady: () => ready.promise, loadAccounts });
    const first = owner.accounts.get();
    await Promise.resolve();
    expect(loadAccounts).not.toHaveBeenCalled();
    ready.resolve();
    const runtime = await first;
    expect(loadAccounts).toHaveBeenCalledTimes(1);
    expect(module.createDesktopAccountServices).toHaveBeenCalledTimes(1);
    expect(await runtime.accounts.list()).toEqual([]);
    await owner.dispose();
    expect(module.cleanup).toHaveBeenCalledTimes(1);
  });

  it('does not load an integration after shutdown starts while Electron is becoming ready', async () => {
    const ready = deferred<void>();
    const whenReady = vi.fn(() => ready.promise);
    const loadAccounts = vi.fn(async () => runtimeModule());
    const owner = new ApplicationServices({ whenReady, loadAccounts });
    const first = owner.accounts.get();
    const rejected = expect(first).rejects.toBeInstanceOf(ServiceClosedError);
    await vi.waitFor(() => expect(whenReady).toHaveBeenCalled());
    const closing = owner.dispose();
    ready.resolve();
    await closing;
    await rejected;
    expect(loadAccounts).not.toHaveBeenCalled();
  });

  it('does not construct a runtime when its module finishes loading after shutdown', async () => {
    const module = runtimeModule();
    const importing = deferred<typeof module>();
    const loadAccounts = vi.fn(() => importing.promise);
    const owner = new ApplicationServices({ whenReady: async () => undefined, loadAccounts });
    const first = owner.accounts.get();
    const rejected = expect(first).rejects.toBeInstanceOf(ServiceClosedError);
    await vi.waitFor(() => expect(loadAccounts).toHaveBeenCalled());
    const closing = owner.dispose();
    importing.resolve(module);
    await closing;
    await rejected;
    expect(module.createDesktopAccountServices).not.toHaveBeenCalled();
  });
});
