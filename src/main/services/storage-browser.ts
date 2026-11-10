import { realpath, stat } from 'node:fs/promises';
import type { AccountSummary } from '../../shared/accounts';
import type { ConnectionDefinition, EntryRef, Space } from '../../shared/storage';
import {
  emptyLocalConnection,
  localConnectionId,
  type SpaceChoice,
  type StorageConnectionSummary,
} from '../../shared/storage-browser';
import { AccountError } from '../accounts/core/errors';
import { AdapterRegistry, StorageAccess, StorageError, type StorageLogger } from '../storage';
import {
  googleDriveAdapterFactory,
  myDriveSpace,
} from '../storage/providers/google-drive/google-drive-adapter';
import {
  localAdapterFactory,
  localFailure,
  localSpace,
} from '../storage/providers/local/local-adapter';
import type { AccountRuntime } from './application-services';
import { measureDirectorySize } from './measure-directory-size';
import type { StoragePreferences } from './storage-preferences';

const localConnection: ConnectionDefinition = {
  id: localConnectionId,
  provider: 'local',
  configuration: {},
};
const browserAuthentication = { method: 'browser' };

export class StorageBrowser {
  private readonly registry: AdapterRegistry;
  private readonly storage: StorageAccess;
  private readonly connections = new Map<string, Promise<void>>();
  private readonly discovered = new Map<string, Map<string, Space>>();
  private readonly authorizationRequired = new Set<string>();
  private authorization: AbortController | undefined;
  private directoryMeasurement: { id: string; controller: AbortController } | undefined;

  constructor(
    private readonly preferences: StoragePreferences,
    private readonly getAccounts: (signal?: AbortSignal) => Promise<AccountRuntime>,
    logger: StorageLogger,
  ) {
    this.registry = new AdapterRegistry({
      logger,
      credentials: {
        resolve: async (reference, ctx) =>
          (await getAccounts(ctx.signal)).credentials.resolve(reference, ctx),
      },
    });
    this.registry.register(localAdapterFactory(() => preferences.folders()));
    this.registry.register(googleDriveAdapterFactory());
    this.storage = new StorageAccess(this.registry, {
      async load() {
        throw new StorageError('Unsupported');
      },
      async save() {
        throw new StorageError('Unsupported');
      },
    });
  }

  async listConnections(): Promise<StorageConnectionSummary[]> {
    const { accounts } = await this.getAccounts();
    const result = (await accounts.list('google-drive')).map((account) =>
      this.summarizeAccount(account),
    );
    if (this.preferences.selectedSpaces(localConnectionId)) {
      result.push({
        ...emptyLocalConnection,
        detail: { messageKey: 'localFileSystem' },
        spaces: this.displayedSpaces(localConnectionId),
      });
    }
    return result;
  }

  async listSpaces(id: string): Promise<SpaceChoice[]> {
    return this.withConnection(id, async () => {
      const available = await this.storage.listSpaces(id);
      const known = new Map(available.map((space) => [space.id, space]));
      this.discovered.set(id, known);
      const choices = available.map((space) => ({ space, available: true }));
      for (const space of this.displayedSpaces(id)) {
        if (!known.has(space.id)) choices.push({ space, available: false });
      }
      return choices;
    });
  }

  async saveSpaces(id: string, spaceIds: string[]): Promise<void> {
    await this.definition(id);
    const builtIn = this.builtInSpace(id);
    const spaces = new Map(this.displayedSpaces(id).map((space) => [space.id, space]));
    for (const [spaceId, space] of this.discovered.get(id) ?? []) spaces.set(spaceId, space);
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
    try {
      const folder = await realpath(path);
      if (!(await stat(folder)).isDirectory()) throw new StorageError('InvalidArgument');
      this.preferences.addFolder(folder);
      const space = localSpace(localConnectionId, folder);
      const spaces = this.discovered.get(localConnectionId) ?? new Map<string, Space>();
      spaces.set(space.id, space);
      this.discovered.set(localConnectionId, spaces);
      return space;
    } catch (error) {
      localFailure(error);
    }
  }

  async addGoogleDrive(): Promise<StorageConnectionSummary> {
    return this.runAuthorization(async (signal) => {
      const { accounts } = await this.getAccounts(signal);
      const account = await accounts.add('google-drive', browserAuthentication, { signal });
      this.authorizationRequired.delete(account.id);
      return this.summarizeAccount(account);
    });
  }

  async reauthorize(id: string): Promise<void> {
    if (id === localConnectionId) throw new AccountError('Unsupported');
    await this.runAuthorization(async (signal) => {
      const { accounts } = await this.getAccounts(signal);
      await accounts.updateAuthentication(id, browserAuthentication, { signal });
      this.authorizationRequired.delete(id);
    });
  }

  cancelAuthorization(): void {
    this.authorization?.abort();
  }

  async listDirectory(parent: EntryRef, cursor?: string) {
    return this.withBrowsableSpace(parent, () => this.storage.list(parent, { cursor }));
  }

  async measureDirectorySize(id: string, folders: EntryRef[]): Promise<number | null> {
    const first = folders[0];
    if (
      !first ||
      folders.some(
        ({ connectionId, spaceId }) =>
          connectionId !== first.connectionId || spaceId !== first.spaceId,
      )
    ) {
      throw new StorageError('InvalidArgument');
    }

    this.directoryMeasurement?.controller.abort();
    const measurement = { id, controller: new AbortController() };
    this.directoryMeasurement = measurement;
    try {
      return await this.withBrowsableSpace(first, () =>
        measureDirectorySize(this.storage, folders, measurement.controller.signal),
      );
    } finally {
      if (this.directoryMeasurement === measurement) this.directoryMeasurement = undefined;
    }
  }

  cancelDirectoryMeasurement(id: string): void {
    if (this.directoryMeasurement?.id === id) this.directoryMeasurement.controller.abort();
  }

  async dispose(): Promise<void> {
    this.cancelAuthorization();
    this.directoryMeasurement?.controller.abort();
    await this.registry.dispose();
  }

  private async withBrowsableSpace<T>({ connectionId, spaceId }: EntryRef, run: () => Promise<T>) {
    return this.withConnection(connectionId, () => {
      if (
        !this.discovered.get(connectionId)?.has(spaceId) &&
        !this.displayedSpaces(connectionId).some((space) => space.id === spaceId)
      ) {
        throw new StorageError('NotFound');
      }
      return run();
    });
  }

  private displayedSpaces(id: string): Space[] {
    const saved = this.preferences.selectedSpaces(id);
    const builtIn = this.builtInSpace(id);
    if (!saved) return builtIn ? [builtIn] : [];

    const discovered = this.discovered.get(id);
    return saved.map(({ id: spaceId, cached }) => {
      const latest = discovered?.get(spaceId);
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

  private builtInSpace(id: string): Space | undefined {
    return id === localConnectionId ? undefined : myDriveSpace(id);
  }

  private summarizeAccount(account: AccountSummary): StorageConnectionSummary {
    return {
      id: account.id,
      provider: 'google-drive',
      name: account.displayName || account.email || 'Google Drive',
      detail:
        account.email && account.displayName ? 'Google Drive · ' + account.email : 'Google Drive',
      needsAuthorization:
        account.authorization === 'reauthorization-required' ||
        this.authorizationRequired.has(account.id),
      spaces: this.displayedSpaces(account.id),
    };
  }

  private async definition(id: string): Promise<ConnectionDefinition> {
    if (id === localConnectionId) return localConnection;
    const { accounts } = await this.getAccounts();
    return accounts.getConnectionDefinition(id);
  }

  private async withConnection<T>(id: string, run: () => Promise<T>): Promise<T> {
    const definition = await this.definition(id);
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
      return await run();
    } catch (error) {
      if (error instanceof StorageError && error.code === 'AuthRequired') {
        this.authorizationRequired.add(id);
      }
      throw error;
    }
  }

  private async runAuthorization<T>(run: (signal: AbortSignal) => Promise<T>): Promise<T> {
    if (this.authorization) throw new AccountError('Busy');
    const controller = new AbortController();
    this.authorization = controller;
    try {
      return await run(controller.signal);
    } finally {
      this.authorization = undefined;
    }
  }
}
