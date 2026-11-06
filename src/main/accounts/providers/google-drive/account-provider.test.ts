import { describe, expect, it, vi } from 'vitest';
import { fingerprint } from '../../../storage/core/validation';
import { matchesGoogleDriveAuthorization } from './credential-resolver';
import { AccountError } from '../../core/errors';
import type { GoogleAuthorizationGrant } from './ports';
import { accountFixture, authorizationGrant } from './testing/fixtures';
import { deferred } from '../../../testing/deferred';

describe('Google Drive account lifecycle', () => {
  it('deduplicates a login and keeps connection fingerprints stable when labels or tokens change', async () => {
    const fixture = accountFixture();
    const first = await fixture.accounts.add('google-drive', { method: 'browser' });
    const definition = fixture.accounts.getConnectionDefinition(first.id);
    fixture.gateway.exchange.mockResolvedValue({
      ...authorizationGrant(),
      email: 'changed@example.test',
      refreshToken: 'new-refresh',
    });
    fixture.gateway.check.mockResolvedValue({ displayName: 'Renamed account' });
    const duplicate = await fixture.accounts.add('google-drive', { method: 'browser' });
    expect(duplicate.id).toBe(first.id);
    expect(duplicate.displayName).toBe('Renamed account');
    expect(await fixture.accounts.list()).toHaveLength(1);
    expect(fingerprint(fixture.accounts.getConnectionDefinition(first.id))).toBe(
      fingerprint(definition),
    );
    expect(fixture.store.records[0]?.revision).toBe(2);
    await fixture.accounts.dispose();
  });

  it('preserves the old grant when reauthorization chooses a different identity', async () => {
    const fixture = accountFixture();
    const first = await fixture.accounts.add('google-drive', { method: 'browser' });
    const stored = structuredClone(fixture.store.data);
    fixture.gateway.exchange.mockResolvedValue(authorizationGrant('someone-else'));
    await expect(
      fixture.accounts.updateAuthentication(first.id, { method: 'browser' }),
    ).rejects.toMatchObject({
      code: 'IdentityMismatch',
    });
    expect(fixture.store.data).toEqual(stored);
    expect(fixture.close).toHaveBeenCalledTimes(2);
    await fixture.accounts.dispose();
  });

  it('accepts a same-account replacement without a new refresh token only when a saved grant is usable', async () => {
    const fixture = accountFixture();
    const first = await fixture.accounts.add('google-drive', { method: 'browser' });
    const replacement = { ...authorizationGrant(), refreshToken: undefined };
    fixture.gateway.exchange.mockResolvedValue(replacement);
    await expect(
      fixture.accounts.updateAuthentication(first.id, { method: 'browser' }),
    ).resolves.toMatchObject({ id: first.id });
    await fixture.accounts.dispose();
    const restored = fixture.createServices();
    await expect(restored.accounts.verify(first.id)).resolves.toMatchObject({ outcome: 'ok' });
    expect(fixture.gateway.refresh).toHaveBeenCalledWith(
      'refresh-google-subject-personal',
      'google-subject-personal',
      expect.anything(),
    );
    await restored.accounts.dispose();
  });

  it('rejects partial consent or a missing persistent grant without saving an account', async () => {
    for (const grant of [
      { ...authorizationGrant(), grantedScopes: ['openid', 'email'] },
      { ...authorizationGrant(), refreshToken: undefined },
    ]) {
      const fixture = accountFixture();
      fixture.gateway.exchange.mockResolvedValue(grant);
      await expect(
        fixture.accounts.add('google-drive', { method: 'browser' }),
      ).rejects.toBeInstanceOf(AccountError);
      expect(await fixture.accounts.list()).toEqual([]);
      expect(fixture.store.writes).toBe(0);
      await fixture.accounts.dispose();
    }
  });

  it('preserves existing records when the candidate API check or persistence fails', async () => {
    const fixture = accountFixture();
    const first = await fixture.accounts.add('google-drive', { method: 'browser' });
    const stored = structuredClone(fixture.store.data);
    fixture.gateway.check.mockRejectedValueOnce(new AccountError('ApiDisabled'));
    await expect(
      fixture.accounts.updateAuthentication(first.id, { method: 'browser' }),
    ).rejects.toMatchObject({
      code: 'ApiDisabled',
    });
    expect(fixture.store.data).toEqual(stored);
    fixture.store.failWrites = true;
    await expect(
      fixture.accounts.updateAuthentication(first.id, { method: 'browser' }),
    ).rejects.toMatchObject({
      code: 'PersistenceFailed',
    });
    await expect(fixture.accounts.remove(first.id)).rejects.toMatchObject({
      code: 'PersistenceFailed',
    });
    expect(fixture.store.data).toEqual(stored);
    expect(await fixture.accounts.list()).toHaveLength(1);
    fixture.store.failWrites = false;
    await expect(fixture.accounts.verify(first.id)).resolves.toMatchObject({ outcome: 'ok' });
    await fixture.accounts.dispose();
  });

  it('separates a connectivity failure from authorization and retries a stale access token once', async () => {
    const fixture = accountFixture();
    const first = await fixture.accounts.add('google-drive', { method: 'browser' });
    fixture.gateway.check.mockRejectedValueOnce(new AccountError('NetworkError'));
    await expect(fixture.accounts.verify(first.id)).rejects.toMatchObject({ code: 'NetworkError' });
    expect((await fixture.accounts.list())[0]).toMatchObject({
      authorization: 'authorized',
      lastCheck: { errorCode: 'NetworkError' },
    });
    fixture.gateway.check.mockRejectedValueOnce(new AccountError('AuthRequired'));
    await expect(fixture.accounts.verify(first.id)).resolves.toMatchObject({ outcome: 'ok' });
    expect(fixture.gateway.refresh).toHaveBeenCalledTimes(1);
    await fixture.accounts.dispose();
  });

  it('keeps account metadata when encryption fails and never exposes private error details', async () => {
    const fixture = accountFixture();
    fixture.cipher.failEncryption = true;
    const failure = await fixture.accounts
      .add('google-drive', { method: 'browser' })
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(AccountError);
    expect(JSON.stringify(failure)).not.toContain('private');
    expect(await fixture.accounts.list()).toEqual([]);
    fixture.cipher.failEncryption = false;
    const account = await fixture.accounts.add('google-drive', { method: 'browser' });
    await fixture.accounts.dispose();
    fixture.cipher.failDecryption = true;
    const restored = fixture.createServices();
    await expect(restored.accounts.verify(account.id)).rejects.toMatchObject({
      code: 'CredentialStoreUnavailable',
    });
    expect((await restored.accounts.list())[0]).toMatchObject({ credentials: 'unavailable' });
    expect(fixture.store.records).toHaveLength(1);
    expect(JSON.stringify(fixture.logger.event.mock.calls)).not.toMatch(
      /refresh-|access-|@example|private/,
    );
    await restored.accounts.dispose();
  });

  it('serializes interactive login and drops a cancelled late token exchange', async () => {
    const fixture = accountFixture();
    const pending = deferred<GoogleAuthorizationGrant>();
    fixture.gateway.exchange.mockReturnValue(pending.promise);
    const controller = new AbortController();
    const first = fixture.accounts.add(
      'google-drive',
      { method: 'browser' },
      { signal: controller.signal },
    );
    const rejection = expect(first).rejects.toMatchObject({ code: 'Cancelled' });
    await vi.waitFor(() => expect(fixture.gateway.exchange).toHaveBeenCalled());
    await expect(fixture.accounts.add('google-drive', { method: 'browser' })).rejects.toMatchObject(
      { code: 'Busy' },
    );
    controller.abort();
    pending.resolve(authorizationGrant());
    await rejection;
    expect(fixture.store.writes).toBe(0);
    expect(fixture.close).toHaveBeenCalled();
    await fixture.accounts.dispose();
  });

  it('times out and releases a listener while waiting for the browser callback', async () => {
    const fixture = accountFixture({ authorizationTimeoutMs: 10 });
    const pending = deferred<string>();
    fixture.environment.listen = vi.fn(async () => ({
      redirectUri: 'http://127.0.0.1:12345/oauth2/callback',
      code: pending.promise,
      close: fixture.close,
    }));
    const services = fixture.createServices();
    await expect(
      services.accounts.add('google-drive', { method: 'browser' }),
    ).rejects.toMatchObject({ code: 'Timeout' });
    expect(fixture.close).toHaveBeenCalled();
    expect(fixture.store.writes).toBe(0);
    await services.accounts.dispose();
    await fixture.accounts.dispose();
  });

  it('cleans up the callback on browser failure and on application shutdown', async () => {
    const fixture = accountFixture();
    vi.mocked(fixture.environment.openBrowser).mockRejectedValueOnce(
      new Error('private browser detail'),
    );
    await expect(fixture.accounts.add('google-drive', { method: 'browser' })).rejects.toMatchObject(
      { code: 'BrowserUnavailable' },
    );
    expect(fixture.close).toHaveBeenCalledTimes(1);
    fixture.environment.listen = vi.fn(async () => ({
      redirectUri: 'http://127.0.0.1:12345/oauth2/callback',
      code: deferred<string>().promise,
      close: fixture.close,
    }));
    const services = fixture.createServices();
    const login = services.accounts.add('google-drive', { method: 'browser' });
    const rejected = expect(login).rejects.toMatchObject({ code: 'Cancelled' });
    await vi.waitFor(() => expect(fixture.environment.listen).toHaveBeenCalled());
    await services.accounts.dispose();
    await rejected;
    expect(fixture.close).toHaveBeenCalledTimes(2);
    expect(fixture.store.writes).toBe(0);
    await fixture.accounts.dispose();
  });

  it('removes only the selected account and never reuses its connection or credential identity', async () => {
    const fixture = accountFixture();
    const first = await fixture.accounts.add('google-drive', { method: 'browser' });
    const definition = fixture.accounts.getConnectionDefinition(first.id);
    const oldHandle = await fixture.credentials.resolve(definition.credentialRef!, {});
    fixture.gateway.exchange.mockResolvedValue(authorizationGrant('work'));
    const work = await fixture.accounts.add('google-drive', { method: 'browser' });
    expect(matchesGoogleDriveAuthorization(oldHandle, definition)).toBe(true);
    expect(
      matchesGoogleDriveAuthorization(oldHandle, fixture.accounts.getConnectionDefinition(work.id)),
    ).toBe(false);
    await fixture.accounts.remove(first.id);
    await expect(oldHandle.getAccessToken()).rejects.toMatchObject({ code: 'NotFound' });
    fixture.gateway.exchange.mockResolvedValue(authorizationGrant());
    const addedAgain = await fixture.accounts.add('google-drive', { method: 'browser' });
    expect(addedAgain.id).not.toBe(first.id);
    expect((await fixture.accounts.list()).map((account) => account.id)).toEqual([
      work.id,
      addedAgain.id,
    ]);
    expect(fixture.accounts.getConnectionDefinition(addedAgain.id).credentialRef).not.toBe(
      definition.credentialRef,
    );
    await fixture.accounts.dispose();
  });
});
