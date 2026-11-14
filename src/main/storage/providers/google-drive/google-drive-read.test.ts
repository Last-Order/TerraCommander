import { expect, it, vi } from 'vitest';
import { AdapterRegistry, StorageAccess } from '../..';
import { googleDriveAdapterFactory } from './google-drive-adapter';

async function fixture(media: () => Response | Promise<Response>, file = {}) {
  const request = vi.fn<typeof fetch>(async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : input);
    expect(new Headers(init?.headers).get('authorization')).toBe('Bearer access');
    return url.searchParams.get('alt') === 'media'
      ? media()
      : Response.json({
          id: 'file',
          name: 'file.txt',
          mimeType: 'text/plain',
          capabilities: { canDownload: true },
          ...file,
        });
  });
  const registry = new AdapterRegistry({
    credentials: {
      resolve: async () => ({
        provider: 'google-drive',
        connectionId: 'account',
        subject: 'subject',
        oauthClientId: 'client',
        getAccessToken: async () => 'access',
      }),
    },
    logger: { event() {} },
  });
  registry.register(googleDriveAdapterFactory(request));
  await registry.connect({
    id: 'account',
    provider: 'google-drive',
    configuration: { subject: 'subject', oauthClientId: 'client' },
    credentialRef: 'credential',
  });
  const storage = new StorageAccess(registry, { async load() {}, async save() {} });
  const ref = { connectionId: 'account', spaceId: 'my-drive', locator: 'file' };
  return { registry, storage, ref, request };
}

it('streams Drive content with its response length and authorization', async () => {
  const { registry, storage, ref } = await fixture(
    () => new Response('content', { headers: { 'Content-Length': '7' } }),
  );
  try {
    const handle = await storage.read(ref);
    expect(handle.length).toBe(7);
    const chunks: Buffer[] = [];
    for await (const chunk of handle.stream) chunks.push(chunk as Buffer);
    expect(Buffer.concat(chunks).toString()).toBe('content');
    await handle.dispose();
  } finally {
    await registry.dispose();
  }
});

it.each([
  { file: { capabilities: { canDownload: false } }, code: 'PermissionDenied' },
  { file: { mimeType: 'application/vnd.google-apps.document' }, code: 'Unsupported' },
  { file: { mimeType: 'application/vnd.google-apps.shortcut' }, code: 'Unsupported' },
])('rejects unreadable content before making a media request: $code', async ({ file, code }) => {
  const { registry, storage, ref, request } = await fixture(() => new Response('unused'), file);
  try {
    await expect(storage.read(ref)).rejects.toMatchObject({ code });
    expect(
      request.mock.calls.some(([url]) =>
        (url instanceof Request ? url.url : url.toString()).includes('alt=media'),
      ),
    ).toBe(false);
  } finally {
    await registry.dispose();
  }
});

it('cancels the HTTP body when an unconsumed handle is abandoned', async () => {
  const cancel = vi.fn();
  const { registry, storage, ref } = await fixture(
    () => new Response(new ReadableStream({ cancel })),
  );
  try {
    const handle = await storage.read(ref);
    await handle.dispose();
    expect(cancel).toHaveBeenCalledOnce();
  } finally {
    await registry.dispose();
  }
});
