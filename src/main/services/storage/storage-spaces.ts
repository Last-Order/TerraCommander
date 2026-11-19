import type { EntryRef, Space } from '../../../shared/storage';
import type { SpaceChoice, StorageConnectionSummary } from '../../../shared/storage-browser';
import { StorageAccess, StorageError } from '../../storage';
import type { StorageConnectionManager } from './storage-connections';
import type { StoragePreferences } from './storage-preferences';
import type { StorageProviderIntegration } from './storage-provider';

export class StorageSpaceCatalog {
  private readonly discovered = new Map<string, Map<string, Space>>();
  private readonly spaceDiscovery = new Map<string, Promise<void>>();

  constructor(
    private readonly preferences: StoragePreferences,
    private readonly storage: StorageAccess,
    private readonly connections: StorageConnectionManager,
  ) {}

  async listConnections(): Promise<StorageConnectionSummary[]> {
    const result: StorageConnectionSummary[] = [];
    for (const integration of this.connections.accountIntegrations()) {
      for (const account of await this.connections.listAccountsFor(integration.provider)) {
        result.push(
          integration.summarizeAccount(
            account,
            this.displayedSpaces(account.id, integration),
            this.connections.needsAuthorization(account),
          ),
        );
      }
    }
    for (const local of this.connections.localIntegrations()) {
      const id = local.connectionDefinition.id;
      if (this.preferences.selectedSpaces(id)) {
        result.push(local.summarizeConnection(this.displayedSpaces(id, local)));
      }
    }
    return result;
  }

  async listSpaces(id: string, refresh = false): Promise<SpaceChoice[]> {
    const integration = await this.connections.resolveIntegration(id);
    if (refresh || this.preferences.discoveredSpaces(id) === undefined) {
      await this.discoverSpaces(id);
    }
    const known = this.knownSpaces(id, integration);
    const choices = Array.from(known.values(), (space) => ({ space, available: true }));
    for (const space of this.displayedSpaces(id, integration)) {
      if (!known.has(space.id)) choices.push({ space, available: false });
    }
    return choices;
  }

  async saveSpaces(id: string, spaceIds: string[]): Promise<void> {
    const integration = await this.connections.resolveIntegration(id);
    const builtIn = integration.kind === 'account' ? integration.builtInSpace?.(id) : undefined;
    const spaces = new Map(this.displayedSpaces(id, integration).map((space) => [space.id, space]));
    for (const [spaceId, space] of this.knownSpaces(id, integration)) spaces.set(spaceId, space);
    const selected = spaceIds.map((spaceId) => {
      const space = spaces.get(spaceId);
      if (!space) throw new StorageError('InvalidArgument');
      if (builtIn?.id === spaceId) return { id: spaceId };
      if (typeof space.name !== 'string') throw new StorageError('OutcomeUnknown');
      return { id: spaceId, cached: { name: space.name, locator: space.root.locator } };
    });
    this.preferences.saveSpaces(id, selected);
  }

  async addLocalFolder(path: string): Promise<Space> {
    const local = this.connections.localIntegrations()[0];
    if (!local) throw new StorageError('Unsupported');
    const space = await local.addFolder(path);
    this.discovered.get(local.connectionDefinition.id)?.set(space.id, space);
    return space;
  }

  withBrowsableSpace<T>({ connectionId, spaceId }: EntryRef, run: () => Promise<T>): Promise<T> {
    return this.connections.withConnection(connectionId, (integration) => {
      if (
        !this.knownSpaces(connectionId, integration).has(spaceId) &&
        !this.displayedSpaces(connectionId, integration).some((space) => space.id === spaceId)
      ) {
        throw new StorageError('NotFound');
      }
      return run();
    });
  }

  displayedSpaces(id: string, integration: StorageProviderIntegration): Space[] {
    const saved = this.preferences.selectedSpaces(id);
    const builtIn = integration.kind === 'account' ? integration.builtInSpace?.(id) : undefined;
    if (!saved) return builtIn ? [builtIn] : [];

    const known = this.knownSpaces(id, integration);
    return saved.map(({ id: spaceId, cached }) => {
      const latest = known.get(spaceId);
      if (latest) return latest;
      if (builtIn?.id === spaceId) return builtIn;
      if (!cached) throw new StorageError('OutcomeUnknown');
      return {
        id: spaceId,
        connectionId: id,
        name: cached.name,
        root: { connectionId: id, spaceId, locator: cached.locator },
      };
    });
  }

  private discoverSpaces(id: string): Promise<void> {
    let pending = this.spaceDiscovery.get(id);
    if (!pending) {
      pending = this.connections
        .withConnection(id, async () => {
          const spaces = await this.storage.listSpaces(id);
          this.preferences.saveDiscoveredSpaces(id, spaces);
          this.discovered.delete(id);
        })
        .finally(() => this.spaceDiscovery.delete(id));
      this.spaceDiscovery.set(id, pending);
    }
    return pending;
  }

  private knownSpaces(id: string, integration: StorageProviderIntegration): Map<string, Space> {
    let known = this.discovered.get(id);
    if (!known) {
      known = new Map(this.preferences.discoveredSpaces(id)?.map((space) => [space.id, space]));
      if (integration.kind === 'local') {
        for (const space of integration.extraKnownSpaces(id)) {
          known.set(space.id, space);
        }
      }
      this.discovered.set(id, known);
    }
    return known;
  }
}
