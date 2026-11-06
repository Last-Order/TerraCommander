import { describe, expect, it, vi } from 'vitest';
import type { AccountProviderDescriptor } from '../../../shared/accounts';
import { createAccountServices } from '../runtime/account-services';
import { FakeAccountCipher, MemoryAccountStore } from '../testing/fixtures';
import { deferred } from '../../testing/deferred';
import { KeyAccountProvider } from '../testing/key-account-provider';
import { AccountError } from './errors';
import type {
  AccountProvider,
  AccountProviderRegistration,
  AccountProviderServices,
} from './ports';

function keyRegistration(id: string) {
  const descriptor: AccountProviderDescriptor = {
    id,
    name: id,
    capabilities: {
      authenticationMethods: [{ id: 'key', kind: 'credentials', name: 'Access key' }],
      verify: true,
      updateAuthentication: true,
    },
  };
  const create = vi
    .fn<
      (
        services: AccountProviderServices,
        signal: AbortSignal,
      ) => AccountProvider | Promise<AccountProvider>
    >()
    .mockImplementation((services) => new KeyAccountProvider(id, services));
  return { descriptor, create } satisfies AccountProviderRegistration;
}

const setup = (secret = 'private-key') => ({
  method: 'key',
  data: { identity: 'same-identity', secret },
});

describe('cross-provider account management', () => {
  it('supports independent key-based providers and provider-scoped identities', async () => {
    const alpha = keyRegistration('alpha');
    const beta = keyRegistration('beta');
    const store = new MemoryAccountStore();
    const runtime = createAccountServices({
      store,
      cipher: new FakeAccountCipher(),
      providers: [alpha, beta],
    });
    expect(runtime.accounts.listProviders()).toHaveLength(2);
    expect(await runtime.accounts.list()).toEqual([]);
    expect(alpha.create).not.toHaveBeenCalled();
    const first = await runtime.accounts.add('alpha', setup());
    const second = await runtime.accounts.add('beta', setup('another-private-key'));
    expect(first.id).not.toBe(second.id);
    expect(first.provider).toBe('alpha');
    expect(second.provider).toBe('beta');
    expect(store.records[0]?.identityKey).toBe(store.records[1]?.identityKey);
    const definition = runtime.accounts.getConnectionDefinition(second.id);
    expect(await runtime.credentials.resolve(definition.credentialRef!, {})).toEqual({
      key: 'another-private-key',
    });
    expect(JSON.stringify(await runtime.accounts.list())).not.toMatch(
      /private-key|credentialRef|identityKey|encryptedCredentials|providerData/,
    );
    expect(alpha.create).toHaveBeenCalledTimes(1);
    expect(beta.create).toHaveBeenCalledTimes(1);
    await runtime.dispose();
  });

  it('lists restored metadata without loading providers and removes an unavailable provider locally', async () => {
    const store = new MemoryAccountStore();
    const registration = keyRegistration('keys');
    const first = createAccountServices({
      store,
      cipher: new FakeAccountCipher(),
      providers: [registration],
    });
    const account = await first.accounts.add('keys', setup());
    await first.dispose();
    registration.create.mockClear();
    const restored = createAccountServices({
      store,
      cipher: new FakeAccountCipher(),
      providers: [registration],
    });
    expect(await restored.accounts.list()).toEqual([
      expect.objectContaining({ id: account.id, authorization: 'unchecked' }),
    ]);
    expect(registration.create).not.toHaveBeenCalled();
    await restored.dispose();
    const unavailable = createAccountServices({ store, cipher: new FakeAccountCipher() });
    await expect(unavailable.accounts.verify(account.id)).rejects.toMatchObject({
      code: 'Unsupported',
    });
    await unavailable.accounts.remove(account.id);
    expect(await unavailable.accounts.list()).toEqual([]);
    expect(registration.create).not.toHaveBeenCalled();
    await unavailable.dispose();
  });

  it('checks capabilities and authentication methods before loading a provider', async () => {
    const store = new MemoryAccountStore();
    const registration = keyRegistration('keys');
    const first = createAccountServices({
      store,
      cipher: new FakeAccountCipher(),
      providers: [registration],
    });
    const account = await first.accounts.add('keys', setup());
    await first.dispose();
    registration.create.mockClear();
    registration.descriptor.capabilities.verify = false;
    registration.descriptor.capabilities.updateAuthentication = false;
    const restored = createAccountServices({
      store,
      cipher: new FakeAccountCipher(),
      providers: [registration],
    });
    await expect(restored.accounts.verify(account.id)).rejects.toMatchObject({
      code: 'Unsupported',
    });
    await expect(restored.accounts.updateAuthentication(account.id, setup())).rejects.toMatchObject(
      { code: 'Unsupported' },
    );
    await expect(restored.accounts.add('keys', { method: 'browser' })).rejects.toMatchObject({
      code: 'Unsupported',
    });
    const descriptors = restored.accounts.listProviders();
    descriptors[0]!.name = 'mutated';
    expect(restored.accounts.listProviders()[0]?.name).toBe('keys');
    expect(registration.create).not.toHaveBeenCalled();
    await restored.dispose();
  });

  it('isolates initialization errors and retries only on a later explicit operation', async () => {
    const store = new MemoryAccountStore();
    const alpha = keyRegistration('alpha');
    const beta = keyRegistration('beta');
    const first = createAccountServices({
      store,
      cipher: new FakeAccountCipher(),
      providers: [alpha, beta],
    });
    const one = await first.accounts.add('alpha', setup());
    const two = await first.accounts.add('beta', setup());
    await first.dispose();
    alpha.create.mockRejectedValueOnce(new AccountError('ClientConfigurationInvalid'));
    const restored = createAccountServices({
      store,
      cipher: new FakeAccountCipher(),
      providers: [alpha, beta],
    });
    await expect(restored.accounts.verify(one.id)).rejects.toMatchObject({
      code: 'ClientConfigurationInvalid',
    });
    expect(await restored.accounts.list()).toHaveLength(2);
    await expect(restored.accounts.verify(two.id)).resolves.toMatchObject({ outcome: 'ok' });
    await expect(restored.accounts.verify(one.id)).resolves.toMatchObject({ outcome: 'ok' });
    await restored.dispose();
  });

  it('does not publish account or credential operations after removal while a provider is loading', async () => {
    const store = new MemoryAccountStore();
    const registration = keyRegistration('keys');
    const first = createAccountServices({
      store,
      cipher: new FakeAccountCipher(),
      providers: [registration],
    });
    const account = await first.accounts.add('keys', setup());
    const definition = first.accounts.getConnectionDefinition(account.id);
    await first.dispose();
    const pending = deferred<AccountProvider>();
    let provider: KeyAccountProvider | undefined;
    registration.create.mockImplementation((services) => {
      provider = new KeyAccountProvider('keys', services);
      return pending.promise;
    });
    const restored = createAccountServices({
      store,
      cipher: new FakeAccountCipher(),
      providers: [registration],
    });
    const checking = restored.accounts.verify(account.id);
    const rejectedCheck = expect(checking).rejects.toMatchObject({ code: 'Cancelled' });
    const resolving = restored.credentials.resolve(definition.credentialRef!, {});
    const rejectedCredential = expect(resolving).rejects.toMatchObject({ code: 'NotFound' });
    await vi.waitFor(() => expect(provider).toBeDefined());
    await restored.accounts.remove(account.id);
    await rejectedCheck;
    pending.resolve(provider!);
    await rejectedCredential;
    expect(provider?.verificationCalls).toBe(0);
    expect(await restored.accounts.list()).toEqual([]);
    await restored.dispose();
    expect(provider?.disposals).toBe(1);
  });

  it('disposes a factory result that reports the wrong provider identity', async () => {
    const registration = keyRegistration('expected');
    let wrong: KeyAccountProvider | undefined;
    registration.create.mockImplementation((services) => {
      wrong = new KeyAccountProvider('other', services);
      return wrong;
    });
    const runtime = createAccountServices({
      store: new MemoryAccountStore(),
      cipher: new FakeAccountCipher(),
      providers: [registration],
    });
    await expect(runtime.accounts.add('expected', setup())).rejects.toMatchObject({
      code: 'InvalidResponse',
    });
    expect(wrong?.disposals).toBe(1);
    expect(await runtime.accounts.list()).toEqual([]);
    await runtime.dispose();
    expect(wrong?.disposals).toBe(1);
  });
});
