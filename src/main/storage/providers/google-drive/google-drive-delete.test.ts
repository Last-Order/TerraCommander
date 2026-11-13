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
  const storage = new StorageAccess(registry, { async load() {}, async save() {} });
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
    await expect(storage.remove(ref)).rejects.toMatchObject({ code: 'Unsupported' });
    expect(patched()).toBe(false);
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
