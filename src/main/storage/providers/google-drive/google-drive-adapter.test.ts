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
    const storage = new StorageAccess(registry, { async load() {}, async save() {} });
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
  const storage = new StorageAccess(registry, { async load() {}, async save() {} });
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
