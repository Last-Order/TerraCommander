import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { AccountSetupRequest, AccountState } from '../../../shared/accounts';
import type { OperationContext } from '../../storage/core/contracts';
import { AccountError } from '../core/errors';
import { parseAccountData } from '../core/models';
import type { AccountProvider, AccountProviderServices } from '../core/ports';

const keySetupSchema = z.strictObject({
  method: z.literal('key'),
  data: z.strictObject({ identity: z.string().min(1), secret: z.string().min(1) }),
});

/** Test-only provider proving that common account infrastructure does not require OAuth. */
export class KeyAccountProvider implements AccountProvider {
  disposals = 0;
  verificationCalls = 0;
  private readonly states = new Map<string, AccountState>();

  constructor(
    readonly id: string,
    private readonly services: AccountProviderServices,
  ) {}

  async add(input: AccountSetupRequest, ctx: OperationContext): Promise<string> {
    const request = parseAccountData(keySetupSchema, input, 'InvalidArgument');
    const existing = this.services.repository.findIdentity(this.id, request.data.identity);
    const binding = {
      id: existing?.id ?? randomUUID(),
      provider: this.id,
      identityKey: request.data.identity,
      credentialRef: existing?.credentialRef ?? randomUUID(),
      configuration: { endpoint: this.id },
    };
    const encrypted = await this.services.credentials.encrypt(
      binding,
      { key: request.data.secret },
      ctx,
    );
    const timestamp = new Date(this.services.now()).toISOString();
    await this.services.repository.save(
      {
        ...binding,
        providerData: { version: 1, payload: {} },
        displayName: request.data.identity,
        encryptedCredentials: encrypted,
        createdAt: existing?.createdAt ?? timestamp,
        updatedAt: timestamp,
        revision: (existing?.revision ?? 0) + 1,
      },
      existing?.revision,
      ctx,
    );
    this.states.set(binding.id, { authorization: 'authorized', credentials: 'available' });
    return binding.id;
  }

  async updateAuthentication(
    id: string,
    input: AccountSetupRequest,
    ctx: OperationContext,
  ): Promise<void> {
    const record = this.record(id);
    const request = parseAccountData(keySetupSchema, input, 'InvalidArgument');
    if (record.identityKey !== request.data.identity) throw new AccountError('IdentityMismatch');
    await this.add(input, ctx);
  }

  async verify(id: string, _ctx: OperationContext) {
    this.record(id);
    this.verificationCalls++;
    const check = {
      checkedAt: new Date(this.services.now()).toISOString(),
      outcome: 'ok' as const,
    };
    this.states.set(id, {
      authorization: 'authorized',
      credentials: 'available',
      lastCheck: check,
    });
    return check;
  }

  async remove(id: string, ctx: OperationContext): Promise<void> {
    const record = this.record(id);
    await this.services.repository.remove(id, record.revision, ctx);
    this.states.delete(id);
  }

  getState(id: string): AccountState {
    return this.states.get(id) ?? { authorization: 'unchecked', credentials: 'unchecked' };
  }

  async resolveCredentials(reference: string, ctx: OperationContext): Promise<unknown> {
    const record = this.services.repository.findCredential(reference);
    this.record(record.id);
    if (!record.encryptedCredentials) throw new AccountError('CredentialStoreUnavailable');
    return (await this.services.credentials.decrypt(record, record.encryptedCredentials, ctx))
      .payload;
  }

  async dispose(): Promise<void> {
    this.disposals++;
  }

  private record(id: string) {
    const record = this.services.repository.get(id);
    if (record.provider !== this.id) throw new AccountError('NotFound');
    return record;
  }
}
