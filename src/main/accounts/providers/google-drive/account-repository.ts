import type { OperationContext } from '../../../storage/core/contracts';
import type { AccountRepository } from '../../persistence/account-repository';
import {
  decodeGoogleAccount,
  encodeGoogleAccount,
  googleIdentityKey,
  type GoogleAccountRecord,
} from './models';

/** A typed Google view over the shared repository, with provider ownership checked on every read. */
export class GoogleAccountRepository {
  constructor(private readonly repository: AccountRepository) {}

  get(id: string): GoogleAccountRecord {
    return decodeGoogleAccount(this.repository.get(id));
  }

  findIdentity(subject: string, clientId: string): GoogleAccountRecord | undefined {
    const record = this.repository.findIdentity(
      'google-drive',
      googleIdentityKey(subject, clientId),
    );
    return record ? decodeGoogleAccount(record) : undefined;
  }

  findCredential(reference: string): GoogleAccountRecord {
    return decodeGoogleAccount(this.repository.findCredential(reference));
  }

  save(
    record: GoogleAccountRecord,
    revision: number | undefined,
    ctx: OperationContext,
  ): Promise<void> {
    return this.repository.save(encodeGoogleAccount(record), revision, ctx);
  }

  remove(id: string, revision: number, ctx: OperationContext): Promise<void> {
    this.get(id);
    return this.repository.remove(id, revision, ctx);
  }

  flush(): Promise<void> {
    return this.repository.flush();
  }
}
