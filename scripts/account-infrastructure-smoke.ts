import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { safeStorage } from 'electron';
import { AccountRepository } from '../src/main/accounts/persistence/account-repository';
import { ElectronAccountStore } from '../src/main/accounts/infrastructure/electron-account-store';
import type { AccountRecord } from '../src/main/accounts/core/models';
import { CredentialStore } from '../src/main/accounts/persistence/credential-store';
import { SafeStorageAccountCipher } from '../src/main/accounts/infrastructure/safe-storage-cipher';

/** Loaded only by the explicit infrastructure command, never by the idle harness. */
export async function checkAccountInfrastructure(profile: string): Promise<void> {
  const cipher = new SafeStorageAccountCipher(safeStorage);
  const reference = randomUUID();
  const binding = {
    id: randomUUID(),
    provider: 'synthetic-smoke',
    identityKey: reference,
    credentialRef: reference,
    configuration: {},
  };
  const timestamp = new Date().toISOString();
  const credentials = new CredentialStore(cipher);
  const ciphertext = await credentials.encrypt(binding, { proof: 'synthetic-value' }, {});
  const opened = await credentials.decrypt(binding, ciphertext, {});
  if (
    typeof opened.payload !== 'object' ||
    opened.payload === null ||
    Array.isArray(opened.payload) ||
    opened.payload.proof !== 'synthetic-value'
  ) {
    throw new Error('OS encryption round trip failed.');
  }

  // A separate file uses only synthetic data. The actual smoke accounts remain untouched.
  const directory = join(profile, 'infrastructure-check');
  const repository = new AccountRepository(new ElectronAccountStore(directory));
  const record: AccountRecord = {
    ...binding,
    providerData: { version: 1, payload: {} },
    encryptedCredentials: ciphertext,
    createdAt: timestamp,
    updatedAt: timestamp,
    revision: 1,
  };
  await repository.save(record, undefined, {});
  const restored = new AccountRepository(new ElectronAccountStore(directory));
  if (restored.get(record.id).encryptedCredentials !== ciphertext) {
    throw new Error('Encrypted account persistence round trip failed.');
  }
  await restored.remove(record.id, 1, {});
  process.stdout.write('OS encryption and account restart persistence passed.\n');
}
