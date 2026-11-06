import { z } from 'zod';
import type { JsonValue } from '../../../shared/storage';
import type { OperationContext } from '../../storage/core/contracts';
import { fingerprint } from '../../storage/core/validation';
import { AccountError, assertNotCancelled } from '../core/errors';
import { connectionDefinition, parseAccountData, type CredentialBinding } from '../core/models';
import { waitForAccountOperation } from '../core/operations';
import type { AccountCipher } from '../core/ports';

const envelopeSchema = z.strictObject({
  version: z.literal(1),
  provider: z.string(),
  accountId: z.uuid(),
  credentialRef: z.uuid(),
  identityKey: z.string(),
  connectionFingerprint: z.string(),
  payload: z.json(),
});

/** The shared envelope binds encrypted payloads to one account and one immutable connection. */
export class CredentialStore {
  constructor(private readonly cipher: AccountCipher) {}

  async encrypt(
    binding: CredentialBinding,
    payload: JsonValue,
    ctx: OperationContext,
  ): Promise<string> {
    assertNotCancelled(ctx.signal);
    try {
      const envelope = { ...this.binding(binding), payload };
      parseAccountData(envelopeSchema, envelope, 'CredentialStoreUnavailable');
      const ciphertext = await waitForAccountOperation(
        this.cipher.encrypt(JSON.stringify(envelope)),
        ctx.signal,
      );
      assertNotCancelled(ctx.signal);
      return ciphertext;
    } catch (error) {
      assertNotCancelled(ctx.signal);
      throw new AccountError('CredentialStoreUnavailable', error);
    }
  }

  async decrypt(binding: CredentialBinding, ciphertext: string, ctx: OperationContext) {
    assertNotCancelled(ctx.signal);
    try {
      const opened = await waitForAccountOperation(this.cipher.decrypt(ciphertext), ctx.signal);
      const envelope = parseAccountData(
        envelopeSchema,
        JSON.parse(opened.plaintext) as unknown,
        'CredentialStoreUnavailable',
      );
      const expected = this.binding(binding);
      if (
        Object.entries(expected).some(
          ([key, value]) => envelope[key as keyof typeof expected] !== value,
        )
      ) {
        throw new AccountError('CredentialStoreUnavailable');
      }
      assertNotCancelled(ctx.signal);
      return { payload: envelope.payload, needsReEncryption: opened.needsReEncryption };
    } catch (error) {
      assertNotCancelled(ctx.signal);
      throw new AccountError('CredentialStoreUnavailable', error);
    }
  }

  private binding(binding: CredentialBinding) {
    return {
      version: 1 as const,
      provider: binding.provider,
      accountId: binding.id,
      credentialRef: binding.credentialRef,
      identityKey: binding.identityKey,
      connectionFingerprint: fingerprint(connectionDefinition(binding)),
    };
  }
}
