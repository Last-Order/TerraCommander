import { expect, it, vi } from 'vitest';
import { AdapterRegistry, StorageAccess } from '../..';
import { googleDriveAdapterFactory } from './google-drive-adapter';

it.each([
  { spaceId: 'my-drive', driveId: undefined },
  { spaceId: 'shared:team', driveId: 'team' },
])('implements removal in $spaceId by moving the file to trash', async (space) => {
  const file = {
    id: 'file-id',
    name: 'notes.txt',
    mimeType: 'text/plain',
    driveId: space.driveId,
    trashed: false,
    capabilities: { canTrash: true, canDelete: false },
  };
  let status = 200;
  let result = { ...file, trashed: true };
  const request = vi.fn<typeof fetch>(async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : input);
    expect(url.pathname).toBe('/drive/v3/files/file-id');
    expect(url.searchParams.get('supportsAllDrives')).toBe('true');
    expect(url.searchParams.get('fields')).toContain('canTrash');
    expect(init?.method).not.toBe('DELETE');
    if (init?.method === 'PATCH') {
      expect(new Headers(init.headers).get('content-type')).toBe('application/json');
      expect(init.body).toBe(JSON.stringify({ trashed: true }));
      return Response.json(result, { status });
    }
    return Response.json(file);
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
  const ref = { connectionId: 'account', spaceId: space.spaceId, locator: file.id };
  const patched = () => request.mock.calls.some(([, init]) => init?.method === 'PATCH');
  try {
    await registry.connect({
      id: 'account',
      provider: 'google-drive',
      configuration: { subject: 'subject', oauthClientId: 'client' },
      credentialRef: 'ref',
    });
    expect((await storage.stat(ref)).capabilities).toMatchObject({
      remove: { support: 'supported' },
    });
    await storage.remove(ref);
    expect(patched()).toBe(true);
    file.capabilities.canDelete = true;
    await storage.remove(ref);

    for (const [failureStatus, code] of [
      [401, 'AuthRequired'],
      [403, 'PermissionDenied'],
      [404, 'NotFound'],
      [429, 'RateLimited'],
      [500, 'NetworkError'],
    ] as const) {
      status = failureStatus;
      await expect(storage.remove(ref)).rejects.toMatchObject({ code });
    }
    status = 200;
    for (const unexpected of [
      { ...file, trashed: false },
      { ...file, trashed: true, id: 'different-file' },
      { ...file, trashed: true, driveId: 'different-drive' },
    ]) {
      result = unexpected;
      await expect(storage.remove(ref)).rejects.toMatchObject({ code: 'OutcomeUnknown' });
    }

    request.mockClear();
    file.capabilities.canTrash = false;
    file.capabilities.canDelete = true;
    expect((await storage.stat(ref)).capabilities.remove?.support).toBe('unsupported');
    await expect(storage.remove(ref)).rejects.toMatchObject({ code: 'PermissionDenied' });
    expect(patched()).toBe(false);
    file.capabilities.canTrash = true;
    file.mimeType = 'application/vnd.google-apps.folder';
    result = { ...file, trashed: true };
    expect((await storage.stat(ref)).capabilities.remove?.support).toBe('supported');
    await storage.remove(ref);
    expect(patched()).toBe(true);
    file.mimeType = 'text/plain';
    request.mockClear();
    await expect(
      storage.remove({ ...ref, locator: space.driveId ?? 'root' }),
    ).rejects.toMatchObject({
      code: 'InvalidArgument',
    });
    expect(request).not.toHaveBeenCalled();
    await expect(
      storage.remove({ ...ref, spaceId: space.driveId ? 'my-drive' : 'shared:team' }),
    ).rejects.toMatchObject({ code: 'NotFound' });
    expect(patched()).toBe(false);
  } finally {
    await registry.dispose();
  }
});

it('enforces onlyIfEmpty and expected checksum/size preconditions before trashing on Drive', async () => {
  const sha = 'a'.repeat(64);
  let folderChildren: unknown[] = [{ id: 'child-1', name: 'new.txt', mimeType: 'text/plain' }];
  const request = vi.fn<typeof fetch>(async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : input);
    if (url.pathname === '/drive/v3/files/file-1') {
      if (init?.method === 'PATCH') {
        return Response.json({
          id: 'file-1',
          name: 'a.txt',
          mimeType: 'text/plain',
          size: '5',
          sha256Checksum: sha,
          trashed: true,
          capabilities: { canTrash: true },
        });
      }
      return Response.json({
        id: 'file-1',
        name: 'a.txt',
        mimeType: 'text/plain',
        size: '5',
        sha256Checksum: sha,
        trashed: false,
        capabilities: { canTrash: true },
      });
    }
    if (url.pathname === '/drive/v3/files/dir-1') {
      if (init?.method === 'PATCH') {
        return Response.json({
          id: 'dir-1',
          name: 'folder',
          mimeType: 'application/vnd.google-apps.folder',
          trashed: true,
          capabilities: { canTrash: true },
        });
      }
      return Response.json({
        id: 'dir-1',
        name: 'folder',
        mimeType: 'application/vnd.google-apps.folder',
        trashed: false,
        capabilities: { canTrash: true },
      });
    }
    if (url.pathname === '/drive/v3/files') {
      return Response.json({ files: folderChildren });
    }
    throw new Error('Unexpected URL: ' + url.toString());
  });
  const registry = new AdapterRegistry({
    credentials: {
      async resolve() {
        return {
          provider: 'google-drive',
          connectionId: 'account',
          subject: 'subject',
          oauthClientId: 'client',
          getAccessToken: async () => 'token',
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
    const fileRef = { connectionId: 'account', spaceId: 'my-drive', locator: 'file-1' };
    const dirRef = { connectionId: 'account', spaceId: 'my-drive', locator: 'dir-1' };

    await expect(storage.remove(fileRef, {}, { expectedSize: 6 })).rejects.toMatchObject({
      code: 'SourceChanged',
    });
    await expect(
      storage.remove(
        fileRef,
        {},
        { expectedChecksum: { algorithm: 'sha256', value: 'b'.repeat(64) } },
      ),
    ).rejects.toMatchObject({ code: 'SourceChanged' });
    await storage.remove(
      fileRef,
      {},
      { expectedSize: 5, expectedChecksum: { algorithm: 'sha256', value: sha } },
    );

    await expect(storage.remove(dirRef, {}, { onlyIfEmpty: true })).rejects.toMatchObject({
      code: 'PreconditionFailed',
    });
    folderChildren = [];
    await storage.remove(dirRef, {}, { onlyIfEmpty: true });
  } finally {
    await registry.dispose();
  }
});
