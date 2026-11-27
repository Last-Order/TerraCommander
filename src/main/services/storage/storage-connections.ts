import { AccountError } from '@main/accounts/core/errors';
import { AdapterRegistry, StorageError, type StorageLogger } from '@main/storage';
import type { AccountSummary } from '@shared/accounts';
import type { ConnectionDefinition, Space } from '@shared/storage';
import type { StorageConnectionSummary, StorageProvider } from '@shared/storage-browser';
import type { AccountRuntime } from '../application-services';
import type { StorageProviderIntegration } from './storage-provider';

export interface ManagedConnection {
  readonly id: string;
  readonly integration: StorageProviderIntegration;
  readonly requireSelection?: boolean;
  summarize(spaces: Space[]): StorageConnectionSummary;
}

export class StorageConnectionManager {
  readonly registry: AdapterRegistry;
  private readonly providers = new Map<StorageProvider, StorageProviderIntegration>();
  private readonly builtIns = new Map<string, StorageProviderIntegration>();
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
      if (integration.connection.kind === 'built-in') {
        this.builtIns.set(integration.connection.connectionDefinition.id, integration);
      }
      this.registry.register(integration.createAdapterFactory());
    }
  }

  async listManagedConnections(): Promise<ManagedConnection[]> {
    const accountEntries: ManagedConnection[] = [];
    const builtInEntries: ManagedConnection[] = [];
    for (const integration of this.providers.values()) {
      const source = integration.connection;
      if (source.kind === 'account') {
        const { accounts } = await this.getAccounts();
        for (const account of await accounts.list(integration.provider)) {
          const needsAuth = this.needsAuthorization(account);
          accountEntries.push({
            id: account.id,
            integration,
            summarize: (spaces) => source.summarize(account, spaces, needsAuth),
          });
        }
      } else {
        builtInEntries.push({
          id: source.connectionDefinition.id,
          integration,
          requireSelection: true,
          summarize: (spaces) => source.summarize(spaces),
        });
      }
    }
    return [...accountEntries, ...builtInEntries];
  }

  async resolveIntegration(id: string): Promise<StorageProviderIntegration> {
    const builtIn = this.builtIns.get(id);
    if (builtIn) return builtIn;
    const definition = await this.definition(id);
    return this.integrationForDefinition(definition);
  }

  async addConnection(
    provider: StorageProvider,
    displayedSpaces: (id: string, integration: StorageProviderIntegration) => Space[],
    owner?: number,
  ): Promise<StorageConnectionSummary> {
    const integration = this.providers.get(provider);
    if (!integration) throw new AccountError('Unsupported');
    const source = integration.connection;
    if (source.kind === 'built-in') {
      const id = source.connectionDefinition.id;
      return source.summarize(displayedSpaces(id, integration));
    }
    return this.runAuthorization(owner, async (signal) => {
      const { accounts } = await this.getAccounts(signal);
      const account = await accounts.add(integration.provider, source.defaultAuthentication, {
        signal,
      });
      this.authorizationRequired.delete(account.id);
      return source.summarize(account, displayedSpaces(account.id, integration), false);
    });
  }

  async reauthorize(id: string, owner?: number): Promise<void> {
    if (this.builtIns.has(id)) throw new AccountError('Unsupported');
    await this.runAuthorization(owner, async (signal) => {
      const { accounts } = await this.getAccounts(signal);
      const definition = accounts.getConnectionDefinition(id);
      const integration = this.integrationForDefinition(definition);
      if (integration.authMode === 'none' || integration.connection.kind !== 'account') {
        throw new AccountError('Unsupported');
      }
      await accounts.updateAuthentication(id, integration.connection.defaultAuthentication, {
        signal,
      });
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

  private needsAuthorization(account: AccountSummary): boolean {
    return (
      account.authorization === 'reauthorization-required' ||
      this.authorizationRequired.has(account.id)
    );
  }

  private async definition(id: string): Promise<ConnectionDefinition> {
    const builtIn = this.builtIns.get(id);
    if (builtIn?.connection.kind === 'built-in') return builtIn.connection.connectionDefinition;
    const { accounts } = await this.getAccounts();
    return accounts.getConnectionDefinition(id);
  }

  private integrationForDefinition(definition: ConnectionDefinition): StorageProviderIntegration {
    const integration = this.providers.get(definition.provider as StorageProvider);
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
