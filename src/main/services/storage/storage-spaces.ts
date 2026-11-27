import { StorageAccess, StorageError } from '@main/storage';
import type { EntryRef, Space, SpaceSemantics } from '@shared/storage';
import type { SpaceChoice, StorageConnectionSummary } from '@shared/storage-browser';
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
    for (const entry of await this.connections.listManagedConnections()) {
      if (entry.requireSelection && !this.preferences.selectedSpaces(entry.id)) continue;
      result.push(entry.summarize(this.displayedSpaces(entry.id, entry.integration)));
    }
    return result;
  }

  async ensureDiscovered(id: string, refresh = false): Promise<void> {
    if (refresh || this.preferences.discoveredSpaces(id) === undefined) {
      await this.discoverSpaces(id);
    }
  }

  async listSpaces(id: string, refresh = false): Promise<SpaceChoice[]> {
    const integration = await this.connections.resolveIntegration(id);
    await this.ensureDiscovered(id, refresh);
    const known = this.knownSpaces(id, integration);
    const choices = Array.from(known.values(), (space) => ({ space, available: true }));
    for (const space of this.displayedSpaces(id, integration)) {
      if (!known.has(space.id)) choices.push({ space, available: false });
    }
    return choices;
  }

  async saveSpaces(id: string, spaceIds: string[]): Promise<void> {
    const integration = await this.connections.resolveIntegration(id);
    const builtIn = integration.builtInSpace?.(id);
    const spaces = new Map(this.displayedSpaces(id, integration).map((space) => [space.id, space]));
    for (const [spaceId, space] of this.knownSpaces(id, integration)) spaces.set(spaceId, space);
    const selected = spaceIds.map((spaceId) => {
      const space = spaces.get(spaceId);
      if (!space) throw new StorageError('InvalidArgument');
      if (builtIn?.id === spaceId) return { id: spaceId };
      if (typeof space.name !== 'string') throw new StorageError('OutcomeUnknown');
      return { id: spaceId, cached: { name: space.name, locator: space.root.locator } };
    });
    this.preferences.saveSpaces(id, integration.provider, selected);
  }

  withBrowsableSpace<T>({ connectionId, spaceId }: EntryRef, run: () => Promise<T>): Promise<T> {
    return this.connections.withConnection(connectionId, (integration) => {
      if (!this.findSpace(connectionId, spaceId, integration)) {
        throw new StorageError('NotFound');
      }
      return run();
    });
  }

  async spaceSemantics({ connectionId, spaceId }: EntryRef): Promise<SpaceSemantics | undefined> {
    const integration = await this.connections.resolveIntegration(connectionId);
    const space = this.findSpace(connectionId, spaceId, integration);
    return space?.semantics ?? integration.spaceSemantics;
  }

  displayedSpaces(id: string, integration: StorageProviderIntegration): Space[] {
    const saved = this.preferences.selectedSpaces(id);
    const builtIn = integration.builtInSpace?.(id);
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
        ...(integration.spaceSemantics ? { semantics: integration.spaceSemantics } : {}),
      };
    });
  }

  private discoverSpaces(id: string): Promise<void> {
    let pending = this.spaceDiscovery.get(id);
    if (!pending) {
      pending = this.connections
        .withConnection(id, async (integration) => {
          const spaces = await this.storage.listSpaces(id);
          this.preferences.saveDiscoveredSpaces(id, integration.provider, spaces);
          this.discovered.delete(id);
        })
        .finally(() => this.spaceDiscovery.delete(id));
      this.spaceDiscovery.set(id, pending);
    }
    return pending;
  }

  private findSpace(
    connectionId: string,
    spaceId: string,
    integration: StorageProviderIntegration,
  ): Space | undefined {
    return (
      this.knownSpaces(connectionId, integration).get(spaceId) ??
      this.displayedSpaces(connectionId, integration).find((item) => item.id === spaceId)
    );
  }

  private knownSpaces(id: string, integration: StorageProviderIntegration): Map<string, Space> {
    let known = this.discovered.get(id);
    if (!known) {
      known = new Map(
        this.preferences
          .discoveredSpaces(id)
          ?.map((space) => [
            space.id,
            space.semantics || !integration.spaceSemantics
              ? space
              : { ...space, semantics: integration.spaceSemantics },
          ]),
      );
      this.discovered.set(id, known);
    }
    return known;
  }
}
