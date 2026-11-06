import type { SafeStorage } from 'electron';
import { AccountError } from '../core/errors';
import type { AccountCipher } from '../core/ports';

type EncryptionApi = Pick<
  SafeStorage,
  'isAsyncEncryptionAvailable' | 'encryptStringAsync' | 'decryptStringAsync'
>;

/** No application-owned encryption key or plaintext fallback is stored alongside the file. */
export class SafeStorageAccountCipher implements AccountCipher {
  constructor(private readonly encryption: EncryptionApi) {}

  async encrypt(plaintext: string): Promise<string> {
    try {
      await this.assertAvailable();
      return (await this.encryption.encryptStringAsync(plaintext)).toString('base64');
    } catch (error) {
      throw new AccountError('CredentialStoreUnavailable', error);
    }
  }

  async decrypt(ciphertext: string): Promise<{ plaintext: string; needsReEncryption: boolean }> {
    try {
      await this.assertAvailable();
      const bytes = Buffer.from(ciphertext, 'base64');
      if (!bytes.length || bytes.toString('base64') !== ciphertext) {
        throw new AccountError('CredentialStoreUnavailable');
      }
      const result = await this.encryption.decryptStringAsync(bytes);
      return { plaintext: result.result, needsReEncryption: result.shouldReEncrypt };
    } catch (error) {
      throw new AccountError('CredentialStoreUnavailable', error);
    }
  }

  private async assertAvailable(): Promise<void> {
    if (!(await this.encryption.isAsyncEncryptionAvailable())) {
      throw new AccountError('CredentialStoreUnavailable');
    }
  }
}
