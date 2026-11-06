import { describe, expect, it, vi } from 'vitest';
import { SafeStorageAccountCipher } from './safe-storage-cipher';

describe('OS account encryption', () => {
  it('uses only the async OS encryption API and propagates the re-encryption hint', async () => {
    const native = {
      isAsyncEncryptionAvailable: vi.fn(async () => true),
      encryptStringAsync: vi.fn(async (_plaintext: string) => Buffer.from('opaque-os-ciphertext')),
      decryptStringAsync: vi.fn(async (_bytes: Buffer) => ({
        result: 'private-refresh',
        shouldReEncrypt: true,
      })),
    };
    const cipher = new SafeStorageAccountCipher(native);
    const encrypted = await cipher.encrypt('private-refresh');
    expect(encrypted).not.toContain('private-refresh');
    expect(await cipher.decrypt(encrypted)).toEqual({
      plaintext: 'private-refresh',
      needsReEncryption: true,
    });
    expect(native.decryptStringAsync).toHaveBeenCalledWith(Buffer.from('opaque-os-ciphertext'));
    native.isAsyncEncryptionAvailable.mockResolvedValue(false);
    await expect(cipher.encrypt('private-refresh')).rejects.toMatchObject({
      code: 'CredentialStoreUnavailable',
    });
    expect(native.encryptStringAsync).toHaveBeenCalledTimes(1);
    await expect(cipher.decrypt('not-base64')).rejects.toMatchObject({
      code: 'CredentialStoreUnavailable',
    });
  });
});
