import type {
  AccountCheck,
  AccountProviderDescriptor,
  AccountSetupRequest,
  AccountSummary,
} from '../../../shared/accounts';
import type { OperationContext } from '../../storage/core/contracts';
import type { AccountRepository } from '../persistence/account-repository';
import type { AccountProviderRegistry } from './account-provider-registry';
import { AccountError, accountError, assertNotCancelled } from './errors';
import {
  accountSetupSchema,
  connectionDefinition,
  parseAccountData,
  type AccountRecord,
} from './models';
import { accountOperationScope } from './operations';
import type { AccountProvider } from './ports';

/** Platform-neutral entry point. Reading metadata never instantiates a provider. */
export class AccountManager {
  private readonly lifetime = new AbortController();
  private readonly accountLifetimes = new Map<string, AbortController>();
  private readonly adding = new Set<{ provider: string; controller: AbortController }>();
  private readonly removing = new Set<string>();
  private disposal: Promise<void> | undefined;

  constructor(
    private readonly repository: AccountRepository,
    private readonly providers: AccountProviderRegistry,
  ) {}

  async list(provider?: string): Promise<AccountSummary[]> {
    this.assertOpen();
    return this.repository.list(provider).map((record) => this.summary(record));
  }

  listProviders(): AccountProviderDescriptor[] {
    this.assertOpen();
    return this.providers.list();
  }

  getConnectionDefinition(id: string) {
    this.assertAccountAvailable(id);
    return connectionDefinition(this.repository.get(id));
  }

  async add(
    providerId: string,
    input: AccountSetupRequest,
    ctx: OperationContext = {},
  ): Promise<AccountSummary> {
    this.assertOpen();
    assertNotCancelled(ctx.signal);
    const request = this.authenticationRequest(providerId, input);
    const attempt = { provider: providerId, controller: new AbortController() };
    this.adding.add(attempt);
    const scope = accountOperationScope(
      ctx,
      AbortSignal.any([this.lifetime.signal, attempt.controller.signal]),
    );
    try {
      const provider = await this.providers.get(providerId, scope.context.signal);
      const id = await provider.add(request, scope.context);
      assertNotCancelled(scope.context.signal);
      const record = this.repository.get(id);
      if (record.provider !== providerId) throw new AccountError('InvalidResponse');
      return this.summary(record);
    } catch (error) {
      throw accountError(error, scope.context.signal);
    } finally {
      this.adding.delete(attempt);
      scope.dispose();
    }
  }

  async updateAuthentication(
    id: string,
    input: AccountSetupRequest,
    ctx: OperationContext = {},
  ): Promise<AccountSummary> {
    this.assertAccountAvailable(id);
    const record = this.repository.get(id);
    if (!this.providers.descriptor(record.provider).capabilities.updateAuthentication)
      throw new AccountError('Unsupported');
    const request = this.authenticationRequest(record.provider, input);
    await this.withProvider(id, ctx, (provider, context) =>
      provider.updateAuthentication(id, request, context),
    );
    return this.summary(this.repository.get(id));
  }

  async verify(id: string, ctx: OperationContext = {}): Promise<AccountCheck> {
    this.assertAccountAvailable(id);
    const record = this.repository.get(id);
    if (!this.providers.descriptor(record.provider).capabilities.verify)
      throw new AccountError('Unsupported');
    return this.withProvider(id, ctx, (provider, context) => provider.verify(id, context));
  }

  async remove(id: string, ctx: OperationContext = {}): Promise<void> {
    this.assertAccountAvailable(id);
    assertNotCancelled(ctx.signal);
    const record = this.repository.get(id);
    this.removing.add(id);
    this.accountLifetimes.get(id)?.abort();
    this.accountLifetimes.delete(id);
    for (const attempt of this.adding) {
      if (attempt.provider === record.provider) attempt.controller.abort();
    }
    const scope = accountOperationScope(ctx, this.lifetime.signal);
    try {
      // An unloaded provider has no active authentication or refresh work to cancel.
      // Removing its local record must not require valid SDK/client configuration.
      const provider = this.providers.peek(record.provider);
      if (provider) await provider.remove(id, scope.context);
      else await this.repository.remove(id, record.revision, scope.context);
    } catch (error) {
      throw accountError(error, scope.context.signal);
    } finally {
      this.removing.delete(id);
      scope.dispose();
    }
  }

  assertAccountAvailable(id: string): void {
    this.assertOpen();
    if (this.removing.has(id)) throw new AccountError('Cancelled');
  }

  dispose(): Promise<void> {
    if (!this.disposal) {
      this.disposal = Promise.resolve().then(async () => {
        try {
          await this.providers.dispose();
        } finally {
          await this.repository.flush();
        }
      });
      this.lifetime.abort();
      for (const lifetime of this.accountLifetimes.values()) lifetime.abort();
      for (const attempt of this.adding) attempt.controller.abort();
    }
    return this.disposal;
  }

  private async withProvider<T>(
    id: string,
    ctx: OperationContext,
    operation: (provider: AccountProvider, context: OperationContext) => Promise<T>,
  ): Promise<T> {
    this.assertAccountAvailable(id);
    const record = this.repository.get(id);
    let lifetime = this.accountLifetimes.get(id);
    if (!lifetime) {
      lifetime = new AbortController();
      this.accountLifetimes.set(id, lifetime);
    }
    const scope = accountOperationScope(
      ctx,
      AbortSignal.any([this.lifetime.signal, lifetime.signal]),
    );
    try {
      const provider = await this.providers.get(record.provider, scope.context.signal);
      this.assertAccountAvailable(id);
      this.repository.get(id);
      const result = await operation(provider, scope.context);
      assertNotCancelled(scope.context.signal);
      return result;
    } catch (error) {
      throw accountError(error, scope.context.signal);
    } finally {
      scope.dispose();
    }
  }

  private authenticationRequest(
    providerId: string,
    input: AccountSetupRequest,
  ): AccountSetupRequest {
    const request = parseAccountData(accountSetupSchema, input, 'InvalidArgument');
    const descriptor = this.providers.descriptor(providerId);
    if (
      !descriptor.capabilities.authenticationMethods.some((method) => method.id === request.method)
    ) {
      throw new AccountError('Unsupported');
    }
    return request;
  }

  private summary(record: AccountRecord): AccountSummary {
    const state = this.providers.peek(record.provider)?.getState(record.id);
    return {
      id: record.id,
      provider: record.provider,
      email: record.email,
      displayName: record.displayName,
      authorization: state?.authorization ?? 'unchecked',
      credentials: state?.credentials ?? 'unchecked',
      lastCheck: state?.lastCheck ? structuredClone(state.lastCheck) : undefined,
    };
  }

  private assertOpen(): void {
    assertNotCancelled(this.lifetime.signal);
  }
}
