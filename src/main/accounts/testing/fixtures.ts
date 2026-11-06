import type { AccountSnapshot } from '../core/models';
import type { AccountCipher, AccountSnapshotStore } from '../core/ports';

export const TEST_TIME = Date.UTC(2026, 10, 4);

/** Test-only ciphertext. Production always uses OS-backed encryption. */
export class FakeAccountCipher implements AccountCipher {
  failEncryption = false;
  failDecryption = false;
  needsReEncryption = false;

  async encrypt(plaintext: string): Promise<string> {
    if (this.failEncryption) throw new Error('fake private encryption detail');
    return `test:${Buffer.from(plaintext).toString('base64')}`;
  }

  async decrypt(ciphertext: string) {
    if (this.failDecryption) throw new Error('fake private decryption detail');
    return {
      plaintext: Buffer.from(ciphertext.slice('test:'.length), 'base64').toString(),
      needsReEncryption: this.needsReEncryption,
    };
  }
}

export class MemoryAccountStore implements AccountSnapshotStore {
  data: unknown;
  failWrites = false;
  writes = 0;

  read(): unknown {
    return structuredClone(this.data);
  }
  write(snapshot: AccountSnapshot): void {
    if (this.failWrites) throw new Error('fake private disk detail');
    this.data = structuredClone(snapshot);
    this.writes++;
  }
  get records() {
    return (this.data as AccountSnapshot | undefined)?.accounts ?? [];
  }
}
