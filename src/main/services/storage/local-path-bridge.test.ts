import { mkdir, mkdtempDisposable, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  accountFixture,
  authorizationGrant,
} from '@main/accounts/providers/google-drive/testing/fixtures';
import { createDefaultStorageProviders } from './providers/default-providers';
import { createGoogleDriveStorageProvider } from './providers/google-drive-storage-provider';
import { createLocalStorageProvider } from './providers/local-storage-provider';
import { StoragePreferences } from './storage-preferences';
import { createStoredSpaceValidator } from './storage-provider';
import { createStorageServices } from './storage-services';

function memorySnapshotStore() {
  let saved: unknown;
  return {
    read: () => saved,
    write(snapshot: unknown) {
      saved = structuredClone(snapshot);
    },
  };
}

describe('LocalPathBridge and cross-connection inspection', () => {
  it('silently discovers local volumes without mutating sidebar connections', async () => {
    await using temporary = await mkdtempDisposable(join(tmpdir(), 'terra-bridge-'));
    const root = await realpath(temporary.path);
    const subDir = join(root, 'downloads');
    await mkdir(subDir);
    await writeFile(join(subDir, 'note.txt'), 'hello');

    const { runtime, gateway } = accountFixture();
    gateway.exchange
      .mockResolvedValueOnce(authorizationGrant('google-subject-a'))
      .mockResolvedValueOnce(authorizationGrant('google-subject-b'));
    const volumes = async () => [root];
    const providers = [createLocalStorageProvider(volumes), createGoogleDriveStorageProvider()];
    const preferences = new StoragePreferences(memorySnapshotStore(), {
      validateSpace: createStoredSpaceValidator(providers),
    });
    const services = createStorageServices({
      preferences,
      getAccounts: async () => runtime,
      logger: { event() {} },
      providers,
      localVolumes: volumes,
    });

    try {
      // Sidebar starts empty (user has not added Local Storage).
      expect(await services.browser.listConnections()).toEqual([]);

      const resolvedDir = await services.localPathBridge.resolveDirectory(subDir);
      expect(resolvedDir.entry.kind).toBe('directory');
      expect(resolvedDir.ref.locator).toBe('downloads');

      // Resolving paths silently discovers volumes while keeping sidebar clean!
      expect(await services.browser.listConnections()).toEqual([]);

      const groups = await services.localPathBridge.resolvePaths([join(subDir, 'note.txt')]);
      expect(groups).toHaveLength(1);
      expect(groups[0]!.parent).toEqual(resolvedDir.ref);
      expect(groups[0]!.entries[0]).toMatchObject({ name: 'note.txt', kind: 'file', size: 5 });

      // Reading the resolved local EntryRef through StorageEntryOperations works seamlessly.
      const handle = await services.operations.readEntry(groups[0]!.entries[0]!.ref);
      const chunks: Uint8Array[] = [];
      for await (const chunk of handle.stream) chunks.push(chunk as Uint8Array);
      await handle.dispose();
      expect(Buffer.concat(chunks).toString()).toBe('hello');
    } finally {
      await services.dispose();
      await runtime.dispose();
    }
  });

  it('detects cross-account Google Drive Shared Drive self-containment via ancestor chain', async () => {
    const request = vi.fn<typeof fetch>(async (input) => {
      const url = new URL(input instanceof Request ? input.url : input);
      if (url.pathname === '/drive/v3/files/sub-folder') {
        return Response.json({
          id: 'sub-folder',
          name: 'Sub',
          mimeType: 'application/vnd.google-apps.folder',
          driveId: 'team',
          parents: ['src-folder'],
        });
      }
      if (url.pathname === '/drive/v3/files/src-folder') {
        return Response.json({
          id: 'src-folder',
          name: 'Source',
          mimeType: 'application/vnd.google-apps.folder',
          driveId: 'team',
          parents: ['team'],
        });
      }
      if (url.pathname === '/drive/v3/files/other-folder') {
        return Response.json({
          id: 'other-folder',
          name: 'Other',
          mimeType: 'application/vnd.google-apps.folder',
          driveId: 'team',
          parents: ['team'],
        });
      }
      throw new Error('Unexpected fetch: ' + url.toString());
    });
    vi.stubGlobal('fetch', request);

    const { runtime, gateway } = accountFixture();
    gateway.exchange
      .mockResolvedValueOnce(authorizationGrant('google-subject-a'))
      .mockResolvedValueOnce(authorizationGrant('google-subject-b'));
    const providers = createDefaultStorageProviders();
    const store = memorySnapshotStore();
    let services: ReturnType<typeof createStorageServices> | undefined;
    try {
      const accountA = await runtime.accounts.add('google-drive', { method: 'browser' });
      const accountB = await runtime.accounts.add('google-drive', { method: 'browser' });
      store.write({
        version: 4,
        connections: [
          {
            id: accountA.id,
            provider: 'google-drive',
            spaces: [{ id: 'shared:team', cached: { name: 'Team', locator: 'team' } }],
          },
          {
            id: accountB.id,
            provider: 'google-drive',
            spaces: [{ id: 'shared:team', cached: { name: 'Team', locator: 'team' } }],
          },
        ],
      });
      const preferences = new StoragePreferences(store, {
        validateSpace: createStoredSpaceValidator(providers),
      });
      services = createStorageServices({
        preferences,
        getAccounts: async () => runtime,
        logger: { event() {} },
        providers,
      });

      const sourceRef = {
        connectionId: accountA.id,
        spaceId: 'shared:team',
        locator: 'src-folder',
      };
      const nestedTarget = {
        connectionId: accountB.id,
        spaceId: 'shared:team',
        locator: 'sub-folder',
      };
      const siblingTarget = {
        connectionId: accountB.id,
        spaceId: 'shared:team',
        locator: 'other-folder',
      };

      expect(
        await services.operations.inspectCrossConnectionTransfer(nestedTarget, undefined, [
          { ref: sourceRef, kind: 'directory' },
        ]),
      ).toEqual({ selfContained: true });

      expect(
        await services.operations.inspectCrossConnectionTransfer(siblingTarget, undefined, [
          { ref: sourceRef, kind: 'directory' },
        ]),
      ).toEqual({ selfContained: false });
    } finally {
      vi.unstubAllGlobals();
      await services?.dispose();
      await runtime.dispose();
    }
  });
});
