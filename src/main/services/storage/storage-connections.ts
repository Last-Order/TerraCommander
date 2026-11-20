import type { AccountSummary } from '@shared/accounts';
import type { ConnectionDefinition } from '@shared/storage';
import type { StorageConnectionSummary, StorageProvider } from '@shared/storage-browser';
import { AccountError } from '@main/accounts/core/errors';
import { AdapterRegistry, StorageError, type StorageLogger } from '@main/storage';
import type { AccountRuntime } from '../application-services';
import type {
  AccountStorageProviderIntegration,
  LocalStorageProviderIntegration,
  StorageProviderIntegration,
} from './storage-provider';

export class StorageConnectionManager {
  readonly registry: AdapterRegistry;
  private readonly providers = new Map<StorageProvider, StorageProviderIntegration>();
  private readonly locals = new Map<string, LocalStorageProviderIntegration>();
  private readonly accountProviders = new Map<string, AccountStorageProviderIntegration>();
  private readonly connections = new Map<string, Promise<void>>();
  private readonly authorizationRequired = new Set<string>();
  private authorization: { owner: number | undefined; controller: AbortController } | undefined;

  constructor(
    private readonly getAccounts: (signal?: AbortSignal) => Promise<AccountRuntime>,
    logger: StorageLogger,
    providers: readonly StorageProviderIntegration[],
  ) {
    this.registry = new AdapterRegistry({
      logger,
      credentials: {
        resolve: async (reference, ctx) =>
          (await getAccounts(ctx.signal)).credentials.resolve(reference, ctx),
      },
    });
    for (const integration of providers) {
      this.providers.set(integration.provider, integration);
      if (integration.kind === 'local') {
        this.locals.set(integration.connectionDefinition.id, integration);
      }
      this.registry.register(integration.createAdapterFactory());
    }
  }

  localIntegrations(): readonly LocalStorageProviderIntegration[] {
    return [...this.locals.values()];
  }

  accountIntegrations(): readonly AccountStorageProviderIntegration[] {
    return [...this.providers.values()].filter(
      (integration): integration is AccountStorageProviderIntegration =>
        integration.kind === 'account',
    );
  }

  async listAccountsFor(provider: StorageProvider): Promise<AccountSummary[]> {
    const { accounts } = await this.getAccounts();
    const list = await accounts.list(provider);
    const integration = this.providers.get(provider);
    if (integration?.kind === 'account') {
      for (const account of list) this.accountProviders.set(account.id, integration);
    }
    return list;
  }

  needsAuthorization(account: AccountSummary): boolean {
    return (
      account.authorization === 'reauthorization-required' ||
      this.authorizationRequired.has(account.id)
    );
  }

  async resolveIntegration(id: string): Promise<StorageProviderIntegration> {
    const local = this.locals.get(id);
    if (local) return local;
    const definition = await this.definition(id);
    return this.integrationForDefinition(definition);
  }

  async addConnection(
    provider: StorageProvider,
    summarize: (
      account: AccountSummary,
      integration: AccountStorageProviderIntegration,
    ) => StorageConnectionSummary,
    owner?: number,
  ): Promise<StorageConnectionSummary> {
    const integration = this.providers.get(provider);
    if (!integration || integration.kind !== 'account') throw new AccountError('Unsupported');
    return this.runAuthorization(owner, async (signal) => {
      const { accounts } = await this.getAccounts(signal);
      const account = await accounts.add(integration.provider, integration.defaultAuthentication, {
        signal,
      });
      this.authorizationRequired.delete(account.id);
      this.accountProviders.set(account.id, integration);
      return summarize(account, integration);
    });
  }

  async reauthorize(id: string, owner?: number): Promise<void> {
    if (this.locals.has(id)) throw new AccountError('Unsupported');
    await this.runAuthorization(owner, async (signal) => {
      const { accounts } = await this.getAccounts(signal);
      const definition = accounts.getConnectionDefinition(id);
      const integration = this.integrationForDefinition(definition);
      if (integration.kind !== 'account') throw new AccountError('Unsupported');
      await accounts.updateAuthentication(id, integration.defaultAuthentication, { signal });
      this.authorizationRequired.delete(id);
    });
  }

  cancelAuthorization(owner?: number): void {
    if (owner === undefined || this.authorization?.owner === owner) {
      this.authorization?.controller.abort();
    }
  }

  async withConnection<T>(
    id: string,
    run: (integration: StorageProviderIntegration) => Promise<T>,
  ): Promise<T> {
    const definition = await this.definition(id);
    const integration = this.integrationForDefinition(definition);
    try {
      let connection = this.connections.get(id);
      if (!connection) {
        connection = this.registry.connect(definition).catch((error: unknown) => {
          this.connections.delete(id);
          throw error;
        });
        this.connections.set(id, connection);
      }
      await connection;
      return await run(integration);
    } catch (error) {
      if (error instanceof StorageError && error.code === 'AuthRequired') {
        this.authorizationRequired.add(id);
      }
      throw error;
    }
  }

  async dispose(): Promise<void> {
    this.cancelAuthorization();
    await this.registry.dispose();
  }

  private async definition(id: string): Promise<ConnectionDefinition> {
    const local = this.locals.get(id);
    if (local) return local.connectionDefinition;
    const { accounts } = await this.getAccounts();
    const definition = accounts.getConnectionDefinition(id);
    const integration = this.providers.get(definition.provider as StorageProvider);
    if (integration?.kind === 'account') this.accountProviders.set(id, integration);
    return definition;
  }

  private integrationForDefinition(definition: ConnectionDefinition): StorageProviderIntegration {
    const integration =
      this.providers.get(definition.provider as StorageProvider) ??
      this.accountProviders.get(definition.id);
    if (!integration) throw new StorageError('Unsupported');
    return integration;
  }

  private async runAuthorization<T>(
    owner: number | undefined,
    run: (signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    if (this.authorization) throw new AccountError('Busy');
    const controller = new AbortController();
    const attempt = { owner, controller };
    this.authorization = attempt;
    try {
      return await run(controller.signal);
    } finally {
      if (this.authorization === attempt) this.authorization = undefined;
    }
  }
}
