import { describe, expect, it, vi } from 'vitest';
import { AccountError } from '../../core/errors';
import type { GoogleAuthorizationGrant, GoogleTokenSet } from './ports';
import { accountFixture, authorizationGrant, TEST_TIME } from './testing/fixtures';
import { deferred } from '../../../testing/deferred';

async function savedAccount() {
  const fixture = accountFixture();
  const account = await fixture.accounts.add('google-drive', { method: 'browser' });
  const definition = fixture.accounts.getConnectionDefinition(account.id);
  return { ...fixture, account, definition };
}

describe('Google Drive token ownership and recovery', () => {
  it('shares one refresh while cancellation detaches only the requesting waiter', async () => {
    const fixture = await savedAccount();
    fixture.clock.now += 3_600_000;
    const pending = deferred<GoogleTokenSet>();
    fixture.gateway.refresh.mockReturnValue(pending.promise);
    const handle = await fixture.credentials.resolve(fixture.definition.credentialRef!, {});
    const controller = new AbortController();
    const cancelled = handle.getAccessToken({ signal: controller.signal });
    const failedWait = expect(cancelled).rejects.toMatchObject({ code: 'Cancelled' });
    const remaining = handle.getAccessToken();
    await vi.waitFor(() => expect(fixture.gateway.refresh).toHaveBeenCalledTimes(1));
    controller.abort();
    await failedWait;
    expect(fixture.gateway.refresh.mock.calls[0]?.[2].signal?.aborted).toBe(false);
    pending.resolve({ accessToken: 'shared-access', expiresAt: fixture.clock.now + 3_600_000 });
    await expect(remaining).resolves.toBe('shared-access');
    await fixture.accounts.dispose();
  });

  it('does not let a delayed refresh restore a removed account', async () => {
    const fixture = await savedAccount();
    fixture.clock.now += 3_600_000;
    const pending = deferred<GoogleTokenSet>();
    fixture.gateway.refresh.mockReturnValue(pending.promise);
    const handle = await fixture.credentials.resolve(fixture.definition.credentialRef!, {});
    const refresh = handle.getAccessToken();
    const rejection = expect(refresh).rejects.toMatchObject({ code: 'Cancelled' });
    await vi.waitFor(() => expect(fixture.gateway.refresh).toHaveBeenCalled());
    await fixture.accounts.remove(fixture.account.id);
    await rejection;
    const committed = fixture.store.writes;
    pending.resolve({
      accessToken: 'late-access',
      refreshToken: 'late-refresh',
      expiresAt: fixture.clock.now + 3_600_000,
    });
    await Promise.resolve();
    expect(fixture.store.writes).toBe(committed);
    expect(await fixture.accounts.list()).toEqual([]);
    await fixture.accounts.dispose();
  });

  it('allows another account to refresh while the first account is waiting for Google', async () => {
    const fixture = await savedAccount();
    fixture.gateway.exchange.mockResolvedValue(authorizationGrant('work'));
    const work = await fixture.accounts.add('google-drive', { method: 'browser' });
    fixture.clock.now += 3_600_000;
    const pending = deferred<GoogleTokenSet>();
    fixture.gateway.refresh.mockImplementation((_token, subject) =>
      subject === 'work'
        ? Promise.resolve({ accessToken: 'work-access', expiresAt: fixture.clock.now + 3_600_000 })
        : pending.promise,
    );
    const personalHandle = await fixture.credentials.resolve(fixture.definition.credentialRef!, {});
    const personalRefresh = personalHandle.getAccessToken();
    const rejected = expect(personalRefresh).rejects.toMatchObject({ code: 'Cancelled' });
    await vi.waitFor(() => expect(fixture.gateway.refresh).toHaveBeenCalled());
    const workDefinition = fixture.accounts.getConnectionDefinition(work.id);
    const workHandle = await fixture.credentials.resolve(workDefinition.credentialRef!, {});
    expect(await workHandle.getAccessToken()).toBe('work-access');
    await fixture.accounts.dispose();
    await rejected;
  });

  it('does not let a delayed refresh overwrite same-account reauthorization', async () => {
    const fixture = await savedAccount();
    fixture.clock.now += 3_600_000;
    const pending = deferred<GoogleTokenSet>();
    fixture.gateway.refresh.mockReturnValue(pending.promise);
    const handle = await fixture.credentials.resolve(fixture.definition.credentialRef!, {});
    const refresh = handle.getAccessToken();
    const rejection = expect(refresh).rejects.toMatchObject({ code: 'Cancelled' });
    await vi.waitFor(() => expect(fixture.gateway.refresh).toHaveBeenCalled());
    fixture.gateway.exchange.mockResolvedValue({
      ...authorizationGrant(),
      accessToken: 'reauthorized-access',
      refreshToken: 'reauthorized-refresh',
      expiresAt: fixture.clock.now + 3_600_000,
    });
    await fixture.accounts.updateAuthentication(fixture.account.id, { method: 'browser' });
    await rejection;
    const committed = structuredClone(fixture.store.data);
    pending.resolve({
      accessToken: 'old-access',
      refreshToken: 'old-refresh',
      expiresAt: fixture.clock.now + 3_600_000,
    });
    await Promise.resolve();
    expect(fixture.store.data).toEqual(committed);
    expect(await handle.getAccessToken()).toBe('reauthorized-access');
    await fixture.accounts.dispose();
  });

  it('keeps a rotated refresh token across restart and refuses to return access before saving it', async () => {
    const fixture = await savedAccount();
    fixture.clock.now += 3_600_000;
    const handle = await fixture.credentials.resolve(fixture.definition.credentialRef!, {});
    fixture.gateway.refresh.mockResolvedValue({
      accessToken: 'new-access',
      refreshToken: 'rotated-refresh',
      expiresAt: fixture.clock.now + 3_600_000,
    });
    fixture.store.failWrites = true;
    await expect(handle.getAccessToken()).rejects.toMatchObject({ code: 'AuthRequired' });
    expect(fixture.store.records[0]?.revision).toBe(1);
    fixture.store.failWrites = false;
    expect(await handle.getAccessToken()).toBe('new-access');
    await fixture.accounts.dispose();
    const restored = fixture.createServices();
    fixture.gateway.refresh.mockResolvedValue({
      accessToken: 'after-restart',
      expiresAt: fixture.clock.now + 3_600_000,
    });
    const restoredHandle = await restored.credentials.resolve(
      fixture.definition.credentialRef!,
      {},
    );
    expect(await restoredHandle.getAccessToken()).toBe('after-restart');
    expect(fixture.gateway.refresh.mock.lastCall?.[0]).toBe('rotated-refresh');
    await restored.accounts.dispose();
  });

  it('requires reauthorization for an invalid grant without silently retrying or opening a browser', async () => {
    const fixture = await savedAccount();
    fixture.clock.now += 3_600_000;
    fixture.gateway.refresh.mockRejectedValue(new AccountError('AuthRequired'));
    const browserCalls = vi.mocked(fixture.environment.openBrowser).mock.calls.length;
    await expect(fixture.accounts.verify(fixture.account.id)).rejects.toMatchObject({
      code: 'AuthRequired',
    });
    expect(fixture.gateway.refresh).toHaveBeenCalledTimes(1);
    expect((await fixture.accounts.list())[0]).toMatchObject({
      authorization: 'reauthorization-required',
    });
    expect(fixture.environment.openBrowser).toHaveBeenCalledTimes(browserCalls);
    fixture.gateway.exchange.mockResolvedValue({
      ...authorizationGrant(),
      refreshToken: undefined,
      expiresAt: fixture.clock.now + 3_600_000,
    });
    await expect(
      fixture.accounts.updateAuthentication(fixture.account.id, { method: 'browser' }),
    ).rejects.toMatchObject({
      code: 'AuthRequired',
    });
    expect((await fixture.accounts.list())[0]?.authorization).toBe('reauthorization-required');
    await fixture.accounts.dispose();
  });

  it('rejects expired saved grants without sending them to Google', async () => {
    const fixture = accountFixture();
    fixture.gateway.exchange.mockResolvedValue({
      ...authorizationGrant(),
      refreshExpiresAt: TEST_TIME + 1000,
    });
    const account = await fixture.accounts.add('google-drive', { method: 'browser' });
    await fixture.accounts.dispose();
    fixture.clock.now += 2000;
    const restored = fixture.createServices();
    await expect(restored.accounts.verify(account.id)).rejects.toMatchObject({
      code: 'AuthRequired',
    });
    expect(fixture.gateway.refresh).not.toHaveBeenCalled();
    await restored.accounts.dispose();
  });

  it('persists credentials re-encrypted after OS key rotation', async () => {
    const fixture = await savedAccount();
    await fixture.accounts.dispose();
    fixture.cipher.needsReEncryption = true;
    const restored = fixture.createServices();
    await restored.accounts.verify(fixture.account.id);
    expect(fixture.store.records[0]?.revision).toBe(2);
    await restored.accounts.dispose();
  });

  it('cancels a pending duplicate login when that account is removed', async () => {
    const fixture = await savedAccount();
    const pending = deferred<GoogleAuthorizationGrant>();
    fixture.gateway.exchange.mockReturnValue(pending.promise);
    const login = fixture.accounts.add('google-drive', { method: 'browser' });
    const rejection = expect(login).rejects.toMatchObject({ code: 'Cancelled' });
    await vi.waitFor(() => expect(fixture.gateway.exchange).toHaveBeenCalledTimes(2));
    await fixture.accounts.remove(fixture.account.id);
    await rejection;
    pending.resolve(authorizationGrant());
    await Promise.resolve();
    expect(await fixture.accounts.list()).toEqual([]);
    await fixture.accounts.dispose();
  });

  it('keeps removal blocked even while a cancelled reauthorization releases its own block', async () => {
    const fixture = await savedAccount();
    const pending = deferred<GoogleAuthorizationGrant>();
    fixture.gateway.exchange.mockReturnValue(pending.promise);
    const login = fixture.accounts.updateAuthentication(fixture.account.id, { method: 'browser' });
    const rejected = expect(login).rejects.toMatchObject({ code: 'Cancelled' });
    await vi.waitFor(() => expect(fixture.gateway.exchange).toHaveBeenCalledTimes(2));
    const removing = fixture.accounts.remove(fixture.account.id);
    await expect(
      fixture.credentials.resolve(fixture.definition.credentialRef!, {}),
    ).rejects.toMatchObject({ code: 'Cancelled' });
    await removing;
    await rejected;
    pending.resolve(authorizationGrant());
    expect(await fixture.accounts.list()).toEqual([]);
    await fixture.accounts.dispose();
  });
});
