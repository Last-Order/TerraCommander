import type { OperationContext } from '../../storage/core/contracts';
import type { CredentialResolver } from '../../storage/ports/services';
import type { AccountRepository } from '../persistence/account-repository';
import type { AccountProviderRegistry } from './account-provider-registry';
import { storageAuthorizationError } from './credential-errors';
import { assertNotCancelled } from './errors';

/** Resolve by the stored provider ID, while returning only that provider's backend handle. */
export class AccountCredentialResolver implements CredentialResolver {
  constructor(
    private readonly repository: AccountRepository,
    private readonly providers: AccountProviderRegistry,
    private readonly assertAvailable: (id: string) => void,
  ) {}

  async resolve(reference: string, ctx: OperationContext): Promise<unknown> {
    try {
      assertNotCancelled(ctx.signal);
      const record = this.repository.findCredential(reference);
      this.assertAvailable(record.id);
      const provider = await this.providers.get(record.provider, ctx.signal);
      this.assertAvailable(record.id);
      // Removal can finish while the provider module is loading.
      this.repository.findCredential(reference);
      return await provider.resolveCredentials(reference, ctx);
    } catch (error) {
      throw storageAuthorizationError(error);
    }
  }
}
