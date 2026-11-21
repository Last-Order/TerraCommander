import { expect, it, vi } from 'vitest';
import { AdapterRegistry, StorageAccess } from '../..';
import { googleDriveAdapterFactory } from './google-drive-adapter';

it.each([
  { spaceId: 'my-drive', driveId: undefined },
  { spaceId: 'shared:team', driveId: 'team' },
])(
  'renames Drive entries by ID in $spaceId and enforces permissions and ownership',
  async ({ spaceId, driveId }) => {
    let canRename = true;
    let forbidden = false;
    const file = {
      id: 'file-id',
      name: 'before.txt',
      mimeType: 'text/plain',
      driveId,
    };
    const request = vi.fn<typeof fetch>(async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : input);
      expect(url.pathname).toBe('/drive/v3/files/file-id');
      expect(url.searchParams.get('supportsAllDrives')).toBe('true');
      if (init?.method === 'PATCH') {
        expect(new Headers(init.headers).get('content-type')).toBe('application/json');
        expect(init.body).toBe(JSON.stringify({ name: 'after.txt' }));
        if (forbidden) return Response.json({}, { status: 403 });
        return Response.json({ ...file, name: 'after.txt', capabilities: { canRename } });
      }
      return Response.json({ ...file, capabilities: { canRename } });
    });
    const registry = new AdapterRegistry({
      credentials: {
        async resolve() {
          return {
            provider: 'google-drive',
            connectionId: 'account',
            subject: 'subject',
            oauthClientId: 'client',
            getAccessToken: async () => 'test-access-token',
          };
        },
      },
      logger: { event() {} },
    });
    registry.register(googleDriveAdapterFactory(request));
    const storage = new StorageAccess(registry);
    const ref = { connectionId: 'account', spaceId, locator: file.id };
    try {
      await registry.connect({
        id: 'account',
        provider: 'google-drive',
        configuration: { subject: 'subject', oauthClientId: 'client' },
        credentialRef: 'ref',
      });
      expect(await storage.rename(ref, 'after.txt')).toMatchObject({ name: 'after.txt', ref });
      request.mockClear();
      canRename = false;
      await expect(storage.rename(ref, 'after.txt')).rejects.toMatchObject({
        code: 'PermissionDenied',
      });
      expect(request.mock.calls.some(([, init]) => init?.method === 'PATCH')).toBe(false);
      canRename = true;
      forbidden = true;
      await expect(storage.rename(ref, 'after.txt')).rejects.toMatchObject({
        code: 'PermissionDenied',
      });
      request.mockClear();
      await expect(
        storage.rename({ ...ref, locator: driveId ?? 'root' }, 'after.txt'),
      ).rejects.toMatchObject({ code: 'InvalidArgument' });
      expect(request).not.toHaveBeenCalled();
      await expect(
        storage.rename({ ...ref, spaceId: driveId ? 'my-drive' : 'shared:team' }, 'after.txt'),
      ).rejects.toMatchObject({ code: 'NotFound' });
      expect(request.mock.calls.some(([, init]) => init?.method === 'PATCH')).toBe(false);
    } finally {
      await registry.dispose();
    }
  },
);

it('discovers all shared drives and lists a selected drive through its own corpus', async () => {
  const token = vi.fn(async () => 'test-access-token');
  const request = vi.fn<typeof fetch>(async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : input);
    expect(new Headers(init?.headers).get('authorization')).toBe('Bearer test-access-token');
    const pageToken = url.searchParams.get('pageToken');
    if (url.pathname.endsWith('/drives')) {
      return Response.json(
        pageToken
          ? { drives: [{ id: 'archive', name: 'Archive' }] }
          : { drives: [{ id: 'team', name: 'Team' }], nextPageToken: 'next-drive' },
      );
    }
    if (url.pathname.endsWith('/files/team')) {
      expect(url.searchParams.get('supportsAllDrives')).toBe('true');
      return Response.json({
        id: 'team',
        name: 'Team',
        mimeType: 'application/vnd.google-apps.folder',
        driveId: 'team',
      });
    }
    expect(url.pathname).toBe('/drive/v3/files');
    expect(url.searchParams.get('q')).toBe("'team' in parents and trashed = false");
    expect(url.searchParams.get('corpora')).toBe('drive');
    expect(url.searchParams.get('driveId')).toBe('team');
    expect(url.searchParams.get('includeItemsFromAllDrives')).toBe('true');
    return Response.json(
      pageToken
        ? {
            files: [
              { id: 'second-file', name: 'Duplicate', mimeType: 'text/plain', driveId: 'team' },
            ],
          }
        : {
            files: [
              { id: 'first-file', name: 'Duplicate', mimeType: 'text/plain', driveId: 'team' },
            ],
            nextPageToken: 'next-file',
          },
    );
  });
  const registry = new AdapterRegistry({
    credentials: {
      async resolve() {
        return {
          provider: 'google-drive',
          connectionId: 'account',
          subject: 'subject',
          oauthClientId: 'client',
          getAccessToken: token,
        };
      },
    },
    logger: { event() {} },
  });
  registry.register(googleDriveAdapterFactory(request));
  const storage = new StorageAccess(registry);
  try {
    await registry.connect({
      id: 'account',
      provider: 'google-drive',
      configuration: { subject: 'subject', oauthClientId: 'client' },
      credentialRef: 'ref',
    });
    const spaces = await storage.listSpaces('account');
    expect(spaces).toMatchObject([
      { id: 'my-drive', name: { messageKey: 'myDrive' } },
      { id: 'shared:team', name: 'Team' },
      { id: 'shared:archive', name: 'Archive' },
    ]);
    const sharedDrive = spaces.find(({ id }) => id === 'shared:team');
    if (!sharedDrive) throw new Error('Expected the team drive');
    const first = await storage.list(sharedDrive.root);
    expect(first.entries).toMatchObject([{ ref: { locator: 'first-file' }, name: 'Duplicate' }]);
    expect(first.nextCursor).toBeDefined();
    expect(first.nextCursor).not.toBe('next-file');
    const next = await storage.list(sharedDrive.root, { cursor: first.nextCursor });
    expect(next.entries).toMatchObject([{ ref: { locator: 'second-file' }, name: 'Duplicate' }]);
    expect(token).toHaveBeenCalledTimes(5);
  } finally {
    await registry.dispose();
  }
});

it('reports scope-accurate capabilities, omits absent metadata, and respects cancellation', async () => {
  const request = vi.fn<typeof fetch>(async (input) => {
    const url = new URL(input instanceof Request ? input.url : input);
    if (url.pathname.endsWith('/files/root')) {
      return Response.json({
        id: 'root',
        name: 'My Drive',
        mimeType: 'application/vnd.google-apps.folder',
        capabilities: { canRename: true, canTrash: true },
      });
    }
    if (url.pathname.endsWith('/files/doc')) {
      return Response.json({
        id: 'doc',
        name: 'Notes',
        mimeType: 'application/vnd.google-apps.document',
        capabilities: { canRename: true, canTrash: true, canDownload: true },
      });
    }
    return Response.json({
      id: 'folder',
      name: 'Folder',
      mimeType: 'application/vnd.google-apps.folder',
      capabilities: { canRename: true, canTrash: true },
    });
  });
  const registry = new AdapterRegistry({
    credentials: {
      async resolve() {
        return {
          provider: 'google-drive',
          connectionId: 'account',
          subject: 'subject',
          oauthClientId: 'client',
          getAccessToken: async () => 'test-access-token',
        };
      },
    },
    logger: { event() {} },
  });
  registry.register(googleDriveAdapterFactory(request));
  const storage = new StorageAccess(registry);
  try {
    await registry.connect({
      id: 'account',
      provider: 'google-drive',
      configuration: { subject: 'subject', oauthClientId: 'client' },
      credentialRef: 'ref',
    });
    expect(
      await storage.capabilities({ kind: 'space', connectionId: 'account', spaceId: 'my-drive' }),
    ).toMatchObject({
      list: { support: 'supported' },
      read: { support: 'supported' },
      write: { support: 'unknown' },
    });

    const rootRef = { connectionId: 'account', spaceId: 'my-drive', locator: 'root' };
    const rootEntry = await storage.stat(rootRef);
    expect(rootEntry).not.toHaveProperty('checksums');
    expect(rootEntry).not.toHaveProperty('size');
    expect(rootEntry).not.toHaveProperty('modifiedAt');
    expect(await storage.capabilities({ kind: 'entry', ref: rootRef })).toEqual(
      rootEntry.capabilities,
    );
    expect(rootEntry.capabilities).toMatchObject({
      list: { support: 'supported' },
      rename: { support: 'unsupported' },
      remove: { support: 'unsupported' },
    });

    const docRef = { connectionId: 'account', spaceId: 'my-drive', locator: 'doc' };
    const docEntry = await storage.stat(docRef);
    expect(await storage.capabilities({ kind: 'entry', ref: docRef })).toEqual(
      docEntry.capabilities,
    );
    expect(docEntry.capabilities).toMatchObject({
      read: { support: 'unsupported' },
      rangeRead: { support: 'unsupported' },
      list: { support: 'unsupported' },
      rename: { support: 'supported' },
      remove: { support: 'supported' },
    });

    await expect(
      storage.capabilities(
        { kind: 'connection', connectionId: 'account' },
        {
          signal: AbortSignal.abort(),
        },
      ),
    ).rejects.toMatchObject({ code: 'Cancelled' });
  } finally {
    await registry.dispose();
  }
});

it.each([
  { spaceId: 'my-drive', driveId: undefined, parentLocator: 'root' },
  { spaceId: 'shared:team', driveId: 'team', parentLocator: 'team' },
])(
  'creates folders in $spaceId and enforces parent kind and permissions',
  async ({ spaceId, driveId, parentLocator }) => {
    let canAddChildren = true;
    let parentMimeType = 'application/vnd.google-apps.folder';
    const request = vi.fn<typeof fetch>(async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : input);
      if (init?.method === 'POST') {
        expect(url.pathname).toBe('/drive/v3/files');
        expect(url.searchParams.get('supportsAllDrives')).toBe('true');
        expect(JSON.parse(init.body as string)).toEqual({
          name: 'Photos',
          mimeType: 'application/vnd.google-apps.folder',
          parents: [parentLocator],
        });
        return Response.json({
          id: 'new-folder',
          name: 'Photos',
          mimeType: 'application/vnd.google-apps.folder',
          driveId,
          parents: [parentLocator],
          capabilities: { canAddChildren: true, canRename: true, canTrash: true },
        });
      }
      expect(url.pathname).toBe(`/drive/v3/files/${parentLocator}`);
      return Response.json({
        id: parentLocator,
        name: 'Parent',
        mimeType: parentMimeType,
        driveId,
        capabilities: { canAddChildren },
      });
    });
    const registry = new AdapterRegistry({
      credentials: {
        async resolve() {
          return {
            provider: 'google-drive',
            connectionId: 'account',
            subject: 'subject',
            oauthClientId: 'client',
            getAccessToken: async () => 'test-access-token',
          };
        },
      },
      logger: { event() {} },
    });
    registry.register(googleDriveAdapterFactory(request));
    const storage = new StorageAccess(registry);
    const parent = { connectionId: 'account', spaceId, locator: parentLocator };
    try {
      await registry.connect({
        id: 'account',
        provider: 'google-drive',
        configuration: { subject: 'subject', oauthClientId: 'client' },
        credentialRef: 'ref',
      });
      const created = await storage.createDirectory({ parent, name: 'Photos' });
      expect(created).toMatchObject({
        ref: { connectionId: 'account', spaceId, locator: 'new-folder' },
        name: 'Photos',
        kind: 'directory',
        capabilities: {
          createDirectory: { support: 'supported' },
          write: { support: 'supported' },
        },
      });

      canAddChildren = false;
      await expect(storage.createDirectory({ parent, name: 'Photos' })).rejects.toMatchObject({
        code: 'PermissionDenied',
      });

      canAddChildren = true;
      parentMimeType = 'text/plain';
      await expect(storage.createDirectory({ parent, name: 'Photos' })).rejects.toMatchObject({
        code: 'InvalidArgument',
      });
    } finally {
      await registry.dispose();
    }
  },
);

it('moves Drive entries within the same space and enforces permissions and space boundaries', async () => {
  let canMoveItemWithinDrive = true;
  let canAddChildren = true;
  const request = vi.fn<typeof fetch>(async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : input);
    if (url.pathname === '/drive/v3/files/file-1' && init?.method === 'PATCH') {
      expect(url.searchParams.get('addParents')).toBe('folder-2');
      expect(url.searchParams.get('removeParents')).toBe('folder-1');
      expect(url.searchParams.get('supportsAllDrives')).toBe('true');
      return Response.json({
        id: 'file-1',
        name: 'report.txt',
        mimeType: 'text/plain',
        parents: ['folder-2'],
        capabilities: { canMoveItemWithinDrive: true },
      });
    }
    if (url.pathname === '/drive/v3/files/file-1') {
      return Response.json({
        id: 'file-1',
        name: 'report.txt',
        mimeType: 'text/plain',
        parents: ['folder-1'],
        capabilities: { canMoveItemWithinDrive },
      });
    }
    if (url.pathname === '/drive/v3/files/folder-2') {
      return Response.json({
        id: 'folder-2',
        name: 'Target',
        mimeType: 'application/vnd.google-apps.folder',
        capabilities: { canAddChildren },
      });
    }
    return Response.json({}, { status: 404 });
  });
  const registry = new AdapterRegistry({
    credentials: {
      async resolve() {
        return {
          provider: 'google-drive',
          connectionId: 'account',
          subject: 'subject',
          oauthClientId: 'client',
          getAccessToken: async () => 'test-access-token',
        };
      },
    },
    logger: { event() {} },
  });
  registry.register(googleDriveAdapterFactory(request));
  const storage = new StorageAccess(registry);
  const fileRef = { connectionId: 'account', spaceId: 'my-drive', locator: 'file-1' };
  const targetParent = { connectionId: 'account', spaceId: 'my-drive', locator: 'folder-2' };
  try {
    await registry.connect({
      id: 'account',
      provider: 'google-drive',
      configuration: { subject: 'subject', oauthClientId: 'client' },
      credentialRef: 'ref',
    });
    const moved = await storage.moveWithin(fileRef, { parent: targetParent, name: 'report.txt' });
    expect(moved).toMatchObject({
      name: 'report.txt',
      ref: { connectionId: 'account', spaceId: 'my-drive', locator: 'file-1' },
      capabilities: { moveWithin: { support: 'supported' } },
    });

    await expect(
      storage.moveWithin(fileRef, {
        parent: { connectionId: 'account', spaceId: 'shared:team', locator: 'folder-2' },
        name: 'report.txt',
      }),
    ).rejects.toMatchObject({ code: 'Unsupported' });

    canMoveItemWithinDrive = false;
    await expect(
      storage.moveWithin(fileRef, { parent: targetParent, name: 'report.txt' }),
    ).rejects.toMatchObject({ code: 'PermissionDenied' });

    canMoveItemWithinDrive = true;
    canAddChildren = false;
    await expect(
      storage.moveWithin(fileRef, { parent: targetParent, name: 'report.txt' }),
    ).rejects.toMatchObject({ code: 'PermissionDenied' });
  } finally {
    await registry.dispose();
  }
});
