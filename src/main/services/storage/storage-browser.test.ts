import { mkdir, mkdtempDisposable, realpath, symlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { accountFixture } from '@main/accounts/providers/google-drive/testing/fixtures';
import { createAccountServices } from '@main/accounts/runtime/account-services';
import { FakeAccountCipher, MemoryAccountStore } from '@main/accounts/testing/fixtures';
import { createDefaultStorageProviders } from './providers/default-providers';
import { createGoogleDriveStorageProvider } from './providers/google-drive-storage-provider';
import { internalLocalConnectionId } from './providers/local-storage-provider';
import { createLocalStorageProvider } from './providers/local-storage-provider';
import { StoragePreferences } from './storage-preferences';
import { createStoredSpaceValidator } from './storage-provider';
import {
  createStorageServices,
  type StorageServices,
  type StorageServicesOptions,
} from './storage-services';

function memorySnapshotStore() {
  let saved: unknown;
  return {
    read: () => saved,
    write(snapshot: unknown) {
      saved = structuredClone(snapshot);
    },
  };
}

function createServices(
  snapshotStore: { read(): unknown; write(snapshot: unknown): void },
  getAccounts: StorageServicesOptions['getAccounts'],
  localVolumes?: () => Promise<string[]>,
) {
  const providers = localVolumes
    ? [createLocalStorageProvider(localVolumes), createGoogleDriveStorageProvider()]
    : createDefaultStorageProviders();
  const preferences = new StoragePreferences(snapshotStore, {
    validateSpace: createStoredSpaceValidator(providers),
  });
  return createStorageServices({
    preferences,
    getAccounts,
    logger: { event() {} },
    providers,
  });
}

it('deletes local files without initializing accounts', async () => {
  await using temporary = await mkdtempDisposable(join(tmpdir(), 'terra-delete-mode-'));
  const path = join(temporary.path, 'notes.txt');
  await writeFile(path, 'keep until confirmed');
  const getAccounts = vi.fn(async () => {
    throw new Error('Local deletion must not initialize accounts.');
  });
  const storage = createServices(memorySnapshotStore(), getAccounts, async () => [temporary.path]);
  try {
    const [choice] = await storage.browser.listSpaces(internalLocalConnectionId);
    if (!choice) throw new Error('Expected a local space');
    const { space } = choice;
    const ref = { ...space.root, locator: 'notes.txt' };
    await storage.operations.deleteEntry(ref);
    expect((await storage.browser.listDirectory(space.root)).entries).toEqual([]);
    expect(getAccounts).not.toHaveBeenCalled();
  } finally {
    await storage.dispose();
  }
});

it('routes a shared Drive deletion through the saved account connection', async () => {
  const { runtime } = accountFixture();
  const snapshotStore = memorySnapshotStore();
  let storage: StorageServices | undefined;
  const file = {
    id: 'notes',
    name: 'notes.txt',
    mimeType: 'text/plain',
    driveId: 'team',
    capabilities: { canTrash: true, canDelete: true },
  };
  const request = vi.fn<typeof fetch>(async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : input);
    expect(url.pathname).toBe('/drive/v3/files/notes');
    if (init?.method === 'PATCH') {
      return Response.json({ ...file, trashed: true });
    }
    return Response.json(file);
  });
  vi.stubGlobal('fetch', request);
  try {
    const account = await runtime.accounts.add('google-drive', { method: 'browser' });
    snapshotStore.write({
      version: 4,
      connections: [
        {
          id: account.id,
          provider: 'google-drive',
          spaces: [{ id: 'shared:team', cached: { name: 'Drive', locator: 'team' } }],
        },
      ],
    });
    storage = createServices(snapshotStore, async () => runtime);
    const ref = { connectionId: account.id, spaceId: 'shared:team', locator: file.id };
    await storage.operations.deleteEntry(ref);
    expect(request.mock.calls.map(([, init]) => init?.method ?? 'GET')).toEqual(['GET', 'PATCH']);
  } finally {
    vi.unstubAllGlobals();
    await storage?.dispose();
    await runtime.dispose();
  }
});

it('restores a chosen local space and confines browsing to its saved root', async () => {
  await using temporary = await mkdtempDisposable(join(tmpdir(), 'terra-storage-'));
  const root = join(temporary.path, 'saved');
  const outside = join(temporary.path, 'outside');
  await mkdir(root);
  await mkdir(outside);
  await writeFile(join(outside, 'ignored.txt'), 'outside the saved folder');
  await mkdir(join(root, 'nested'));
  const file = join(root, 'file.txt');
  const modifiedAt = new Date('2026-01-02T03:04:06Z');
  await writeFile(file, 'saved file');
  await utimes(file, modifiedAt, modifiedAt);
  await symlink(outside, join(root, 'redirect'), process.platform === 'win32' ? 'junction' : 'dir');

  const resolvedRoot = await realpath(root);
  const snapshotStore = memorySnapshotStore();
  const accounts = createAccountServices({
    store: new MemoryAccountStore(),
    cipher: new FakeAccountCipher(),
  });
  function openServices() {
    return createServices(
      snapshotStore,
      async () => accounts,
      async () => [resolvedRoot],
    );
  }
  const first = openServices();
  let space;
  try {
    expect(await first.browser.listConnections()).toEqual([]);
    const [choice] = await first.browser.listSpaces(internalLocalConnectionId);
    if (!choice) throw new Error('Expected a local space');
    space = choice.space;
    await first.browser.saveSpaces(internalLocalConnectionId, [space.id]);
  } finally {
    await first.dispose();
  }

  const restored = openServices();
  try {
    expect(await restored.browser.listConnections()).toMatchObject([
      { id: internalLocalConnectionId, spaces: [space] },
    ]);
    expect(await restored.browser.listSpaces(internalLocalConnectionId)).toEqual([
      { space, available: true },
    ]);
    const page = await restored.browser.listDirectory(space.root);
    expect(page.entries).toMatchObject([
      {
        name: 'file.txt',
        kind: 'file',
        displayPath: join(resolvedRoot, 'file.txt'),
        size: 10,
        modifiedAt: modifiedAt.toISOString(),
      },
      { name: 'nested', kind: 'directory', modifiedAt: expect.any(String) },
      { name: 'redirect', kind: 'link' },
    ]);
    const folder = page.entries.find(({ name }) => name === 'nested');
    if (!folder) throw new Error('Expected the nested folder');
    expect(await restored.browser.listDirectory(folder.ref)).toEqual({ entries: [] });
    expect(await restored.browser.measureDirectorySize('size', [space.root])).toBe(10);
    await expect(
      restored.browser.listDirectory({ ...space.root, locator: '..' }),
    ).rejects.toMatchObject({
      code: 'InvalidArgument',
    });
    await expect(
      restored.browser.listDirectory({ ...space.root, locator: 'redirect' }),
    ).rejects.toMatchObject({ code: 'InvalidArgument' });
  } finally {
    await restored.dispose();
    await accounts.dispose();
  }
});

it('lists a local directory beyond the default page size in one response', async () => {
  await using temporary = await mkdtempDisposable(join(tmpdir(), 'terra-storage-'));
  const names = Array.from(
    { length: 101 },
    (_, index) => `file-${String(index).padStart(3, '0')}.txt`,
  );
  await Promise.all(names.map((name) => writeFile(join(temporary.path, name), '')));

  const { runtime } = accountFixture();
  const storage = createServices(
    memorySnapshotStore(),
    async () => runtime,
    async () => [temporary.path],
  );
  try {
    const [choice] = await storage.browser.listSpaces(internalLocalConnectionId);
    if (!choice) throw new Error('Expected a local space');
    const { space } = choice;
    const page = await storage.browser.listDirectory(space.root);
    expect(page.entries.map(({ name }) => name)).toEqual(names);
    expect(page.nextCursor).toBeUndefined();
  } finally {
    await storage.dispose();
    await runtime.dispose();
  }
});

it('persists discovered spaces separately from legacy selections and refreshes them explicitly', async () => {
  const snapshotStore = memorySnapshotStore();
  const { runtime } = accountFixture();
  const request = vi.fn<typeof fetch>().mockImplementation(async () =>
    Response.json({
      drives: [
        { id: 'team', name: 'Team' },
        { id: 'archive', name: 'Archive' },
      ],
    }),
  );
  vi.stubGlobal('fetch', request);

  function openServices() {
    return createServices(snapshotStore, async () => runtime);
  }

  let storage: StorageServices | undefined;
  try {
    const account = await runtime.accounts.add('google-drive', { method: 'browser' });
    const saved = {
      version: 4,
      connections: [
        {
          id: account.id,
          provider: 'google-drive',
          spaces: [
            { id: 'my-drive' },
            { id: 'shared:team', cached: { name: 'Team', locator: 'team' } },
          ],
        },
      ],
    };
    snapshotStore.write(saved);
    storage = openServices();
    const [choices, concurrentChoices] = await Promise.all([
      storage.browser.listSpaces(account.id),
      storage.browser.listSpaces(account.id),
    ]);
    const expectedSpaces = choices.slice(0, 2).map(({ space }) => space);
    expect(choices.map(({ space }) => space.id)).toEqual([
      'my-drive',
      'shared:team',
      'shared:archive',
    ]);
    expect(concurrentChoices).toEqual(choices);
    expect(request).toHaveBeenCalledTimes(1);
    expect(snapshotStore.read()).toEqual({
      ...saved,
      connections: [{ ...saved.connections[0], discovered: choices.map(({ space }) => space) }],
    });
    await storage.dispose();

    request.mockReset().mockRejectedValue(new TypeError('offline'));
    storage = openServices();
    expect(await storage.browser.listConnections()).toMatchObject([
      { id: account.id, spaces: expectedSpaces },
    ]);
    expect(await storage.browser.listSpaces(account.id)).toEqual(choices);
    expect(request).not.toHaveBeenCalled();
    await expect(storage.browser.listSpaces(account.id, true)).rejects.toMatchObject({
      code: 'NetworkError',
    });
    expect(await storage.browser.listSpaces(account.id)).toEqual(choices);
    expect(request).toHaveBeenCalledTimes(1);

    request.mockResolvedValueOnce(Response.json({ drives: [{ id: 'new', name: 'New' }] }));
    const refreshed = await storage.browser.listSpaces(account.id, true);
    expect(refreshed.map(({ space, available }) => [space.id, available])).toEqual([
      ['my-drive', true],
      ['shared:new', true],
      ['shared:team', false],
    ]);
    await storage.browser.saveSpaces(account.id, []);
    await storage.dispose();

    storage = openServices();
    expect(await storage.browser.listConnections()).toMatchObject([{ id: account.id, spaces: [] }]);
    expect(await storage.browser.listSpaces(account.id)).toEqual(refreshed.slice(0, 2));
    expect(request).toHaveBeenCalledTimes(2);
  } finally {
    vi.unstubAllGlobals();
    await storage?.dispose();
    await runtime.dispose();
  }
});

it('keeps StoragePreferences provider-neutral and dispatches validation by provider', () => {
  const localStore = memorySnapshotStore();
  localStore.write({
    version: 4,
    connections: [
      {
        id: internalLocalConnectionId,
        provider: 'local',
        spaces: [{ id: 'custom', cached: { name: 'Custom', locator: 'not-dot' } }],
      },
    ],
  });
  const validateDefault = createStoredSpaceValidator(createDefaultStorageProviders());
  expect(() => new StoragePreferences(localStore)).not.toThrow();
  expect(() => new StoragePreferences(localStore, { validateSpace: validateDefault })).toThrow(
    expect.objectContaining({ code: 'OutcomeUnknown' }),
  );

  const accountStore = memorySnapshotStore();
  accountStore.write({
    version: 4,
    connections: [
      {
        id: 'account-1',
        provider: 'google-drive',
        spaces: [{ id: 'invalid-space', cached: { name: 'Invalid', locator: 'bad' } }],
      },
    ],
  });
  const validateWithAccountRule = createStoredSpaceValidator([
    createLocalStorageProvider(),
    {
      ...createGoogleDriveStorageProvider(),
      validateStoredSpace: ({ id }) => id === 'my-drive' || id.startsWith('shared:'),
    },
  ]);
  expect(
    () => new StoragePreferences(accountStore, { validateSpace: validateDefault }),
  ).not.toThrow();
  expect(
    () => new StoragePreferences(accountStore, { validateSpace: validateWithAccountRule }),
  ).toThrow(expect.objectContaining({ code: 'OutcomeUnknown' }));
});

it('returns the local connection summary from addConnection without persisting selection or initializing accounts', async () => {
  await using temporary = await mkdtempDisposable(join(tmpdir(), 'terra-add-local-'));
  const getAccounts = vi.fn(async () => {
    throw new Error('Adding local connection must not initialize accounts.');
  });
  const storage = createServices(memorySnapshotStore(), getAccounts, async () => [temporary.path]);
  try {
    const initial = await storage.browser.addConnection('local');
    expect(initial).toEqual({
      id: internalLocalConnectionId,
      provider: 'local',
      name: { messageKey: 'thisPc' },
      detail: { messageKey: 'localFileSystem' },
      needsAuthorization: false,
      spaces: [],
    });
    expect(getAccounts).not.toHaveBeenCalled();

    const [choice] = await storage.browser.listSpaces(internalLocalConnectionId);
    if (!choice) throw new Error('Expected a local space');
    await storage.browser.saveSpaces(internalLocalConnectionId, [choice.space.id]);

    const configured = await storage.browser.addConnection('local');
    expect(configured).toEqual({
      ...initial,
      spaces: [choice.space],
    });
    expect(getAccounts).not.toHaveBeenCalled();
  } finally {
    await storage.dispose();
  }
});
