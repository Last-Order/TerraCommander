import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { AccountRepository } from './account-repository';
import type { AccountRecord } from '../core/models';
import { MemoryAccountStore, TEST_TIME } from '../testing/fixtures';

describe('shared account persistence boundaries', () => {
  it('does not clear malformed or unsupported stored account data', () => {
    for (const input of [
      { version: 99, accounts: [] },
      { version: 1, accounts: [{}] },
      'private malformed data',
    ]) {
      const store = new MemoryAccountStore();
      store.data = input;
      expect(() => new AccountRepository(store)).toThrow(
        expect.objectContaining({ code: 'StoreInvalid' }),
      );
      expect(store.data).toEqual(input);
      expect(store.writes).toBe(0);
    }
  });

  it('rejects duplicate identity bindings within one provider', () => {
    const record = accountRecord();
    const store = new MemoryAccountStore();
    store.data = {
      version: 1,
      accounts: [record, { ...record, id: randomUUID(), credentialRef: randomUUID() }],
    };
    expect(() => new AccountRepository(store)).toThrow(
      expect.objectContaining({ code: 'StoreInvalid' }),
    );
  });

  it('serializes writes, snapshots inputs, and preserves the last commit after an I/O failure', async () => {
    const store = new MemoryAccountStore();
    const repository = new AccountRepository(store);
    const record = accountRecord();
    await repository.save(record, undefined, {});
    const renamed: AccountRecord = { ...record, displayName: 'Saved name', revision: 2 };
    const saving = repository.save(renamed, 1, {});
    renamed.displayName = 'Changed after saving was requested';
    await saving;
    expect(repository.get(record.id).displayName).toBe('Saved name');
    store.failWrites = true;
    await expect(repository.save({ ...record, revision: 3 }, 2, {})).rejects.toMatchObject({
      code: 'PersistenceFailed',
    });
    expect(repository.get(record.id).revision).toBe(2);
    store.failWrites = false;
    await repository.save({ ...record, revision: 3 }, 2, {});
    expect(repository.get(record.id).revision).toBe(3);
  });

  it('keeps provider identity and connection configuration immutable during updates', async () => {
    const repository = new AccountRepository(new MemoryAccountStore());
    const record = accountRecord();
    await repository.save(record, undefined, {});
    for (const changed of [
      { ...record, provider: 'another-provider' },
      { ...record, identityKey: 'another-identity' },
      { ...record, configuration: { endpoint: 'replacement' } },
      { ...record, credentialRef: randomUUID() },
    ]) {
      await expect(repository.save({ ...changed, revision: 2 }, 1, {})).rejects.toMatchObject({
        code: 'IdentityMismatch',
      });
    }
    expect(repository.get(record.id)).toEqual(record);
  });
});

function accountRecord(): AccountRecord {
  const timestamp = new Date(TEST_TIME).toISOString();
  return {
    id: randomUUID(),
    provider: 'test-provider',
    identityKey: 'opaque-identity',
    credentialRef: randomUUID(),
    configuration: { endpoint: 'original' },
    providerData: { version: 1, payload: {} },
    createdAt: timestamp,
    updatedAt: timestamp,
    revision: 1,
  };
}
