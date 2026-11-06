import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { FakeAccountCipher } from '../testing/fixtures';
import { CredentialStore } from './credential-store';

describe('shared encrypted credential binding', () => {
  it('rejects ciphertext reused for another account, provider, reference, identity, or connection', async () => {
    const store = new CredentialStore(new FakeAccountCipher());
    const binding = {
      id: randomUUID(),
      provider: 'keys',
      identityKey: 'user',
      credentialRef: randomUUID(),
      configuration: { endpoint: 'original' },
    };
    const ciphertext = await store.encrypt(binding, { privateKey: 'secret' }, {});
    expect((await store.decrypt(binding, ciphertext, {})).payload).toEqual({
      privateKey: 'secret',
    });
    const altered = [
      { ...binding, id: randomUUID() },
      { ...binding, provider: 'other' },
      { ...binding, credentialRef: randomUUID() },
      { ...binding, identityKey: 'other-user' },
      { ...binding, configuration: { endpoint: 'replacement' } },
    ];
    for (const candidate of altered) {
      await expect(store.decrypt(candidate, ciphertext, {})).rejects.toMatchObject({
        code: 'CredentialStoreUnavailable',
      });
    }
  });
});
