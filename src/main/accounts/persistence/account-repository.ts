import type { OperationContext } from '../../storage/core/contracts';
import { assertNotCancelled, AccountError } from '../core/errors';
import {
  accountRecordSchema,
  accountSnapshotSchema,
  parseAccountData,
  type AccountRecord,
  type AccountSnapshot,
} from '../core/models';
import type { AccountSnapshotStore } from '../core/ports';
import { fingerprint } from '../../storage/core/validation';

/** The sole writer of the account snapshot. Readers never receive mutable stored objects. */
export class AccountRepository {
  private snapshot: AccountSnapshot;
  private pendingWrite: Promise<void> = Promise.resolve();

  constructor(private readonly store: AccountSnapshotStore) {
    try {
      const input = store.read();
      this.snapshot =
        input === undefined
          ? { version: 1, accounts: [] }
          : parseAccountData(accountSnapshotSchema, input, 'StoreInvalid');
      this.validateUniqueness(this.snapshot.accounts);
    } catch (error) {
      throw new AccountError('StoreInvalid', error);
    }
  }

  list(provider?: string): AccountRecord[] {
    return structuredClone(
      this.snapshot.accounts.filter(
        (record) => provider === undefined || record.provider === provider,
      ),
    );
  }

  get(id: string): AccountRecord {
    const record = this.snapshot.accounts.find((account) => account.id === id);
    if (!record) throw new AccountError('NotFound');
    return structuredClone(record);
  }

  findIdentity(provider: string, identityKey: string): AccountRecord | undefined {
    return this.list().find(
      (record) => record.provider === provider && record.identityKey === identityKey,
    );
  }

  findCredential(reference: string): AccountRecord {
    const record = this.snapshot.accounts.find((account) => account.credentialRef === reference);
    if (!record) throw new AccountError('NotFound');
    return structuredClone(record);
  }

  save(
    record: AccountRecord,
    expectedRevision: number | undefined,
    ctx: OperationContext,
  ): Promise<void> {
    const candidate = parseAccountData(accountRecordSchema, record, 'InvalidArgument');
    return this.serialize(() => {
      const current = this.snapshot.accounts.find((account) => account.id === candidate.id);
      this.assertRevision(current, expectedRevision);
      if (
        current &&
        (current.provider !== candidate.provider ||
          current.identityKey !== candidate.identityKey ||
          fingerprint(current.configuration) !== fingerprint(candidate.configuration) ||
          current.credentialRef !== candidate.credentialRef ||
          current.createdAt !== candidate.createdAt)
      )
        throw new AccountError('IdentityMismatch');
      if (candidate.revision !== (expectedRevision ?? 0) + 1) {
        throw new AccountError('InvalidArgument');
      }

      const accounts = this.snapshot.accounts.filter((account) => account.id !== candidate.id);
      accounts.push(candidate);
      this.commit(accounts, ctx);
    });
  }

  remove(id: string, expectedRevision: number, ctx: OperationContext): Promise<void> {
    return this.serialize(() => {
      const current = this.snapshot.accounts.find((account) => account.id === id);
      this.assertRevision(current, expectedRevision);
      this.commit(
        this.snapshot.accounts.filter((account) => account.id !== id),
        ctx,
      );
    });
  }

  async flush(): Promise<void> {
    await this.pendingWrite;
  }

  private commit(accounts: AccountRecord[], ctx: OperationContext): void {
    this.validateUniqueness(accounts);
    assertNotCancelled(ctx.signal);
    const snapshot: AccountSnapshot = { version: 1, accounts };
    try {
      // No await between the cancellation guard and atomic replacement. A failed write
      // leaves the in-memory snapshot unchanged, matching the last committed file.
      this.store.write(structuredClone(snapshot));
    } catch (error) {
      throw new AccountError('PersistenceFailed', error);
    }
    this.snapshot = snapshot;
  }

  private serialize(write: () => void): Promise<void> {
    const operation = this.pendingWrite.then(write);
    this.pendingWrite = operation.catch(() => undefined);
    return operation;
  }

  private assertRevision(current: AccountRecord | undefined, expected: number | undefined): void {
    if (current?.revision !== expected) throw new AccountError('Cancelled');
  }

  private validateUniqueness(accounts: AccountRecord[]): void {
    const ids = new Set<string>();
    const references = new Set<string>();
    const identities = new Set<string>();
    for (const account of accounts) {
      const identity = JSON.stringify([account.provider, account.identityKey]);
      if (
        ids.has(account.id) ||
        references.has(account.credentialRef) ||
        identities.has(identity)
      ) {
        throw new AccountError('StoreInvalid');
      }
      ids.add(account.id);
      references.add(account.credentialRef);
      identities.add(identity);
    }
  }
}
