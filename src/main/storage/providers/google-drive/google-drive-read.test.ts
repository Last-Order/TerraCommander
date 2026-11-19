import { expect, it, vi } from 'vitest';
import { AdapterRegistry, StorageAccess } from '../..';
import { googleDriveAdapterFactory } from './google-drive-adapter';

async function fixture(media: (init?: RequestInit) => Response | Promise<Response>, file = {}) {
  const event = vi.fn();
  const request = vi.fn<typeof fetch>(async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : input);
    expect(new Headers(init?.headers).get('authorization')).toBe('Bearer access');
    return url.searchParams.get('alt') === 'media'
      ? media(init)
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
    logger: { event },
  });
  registry.register(googleDriveAdapterFactory(request));
  await registry.connect({
    id: 'account',
    provider: 'google-drive',
    configuration: { subject: 'subject', oauthClientId: 'client' },
    credentialRef: 'credential',
  });
  const storage = new StorageAccess(registry);
  const ref = { connectionId: 'account', spaceId: 'my-drive', locator: 'file' };
  return { registry, storage, ref, request, event };
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

it('distinguishes a failed range request from initial download and metadata failures', async () => {
  const { registry, storage, ref, event } = await fixture(() => {
    throw new TypeError('fetch failed', { cause: { code: 'UND_ERR_SOCKET' } });
  });
  try {
    await expect(storage.read(ref, { range: { offset: 4 } })).rejects.toMatchObject({
      code: 'NetworkError',
    });
    expect(event).toHaveBeenCalledExactlyOnceWith('google-drive.request.failed', {
      stage: 'headers',
      timedOut: false,
      rangeRequested: true,
      errorCode: 'NetworkError',
      networkCode: 'UND_ERR_SOCKET',
    });
  } finally {
    await registry.dispose();
  }
});

it('records a body interruption separately from failure to open a range', async () => {
  const { registry, storage, ref, event } = await fixture(
    () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.error(new TypeError('private details', { cause: { code: 'ECONNRESET' } }));
          },
        }),
        { status: 206, headers: { 'Content-Range': 'bytes 4-6/7' } },
      ),
  );
  try {
    const handle = await storage.read(ref, { range: { offset: 4 } });
    await expect(async () => {
      for await (const _chunk of handle.stream) {
        /* Consume the interrupted response. */
      }
    }).rejects.toMatchObject({ code: 'NetworkError' });
    await handle.dispose();
    expect(event).toHaveBeenCalledExactlyOnceWith('google-drive.request.failed', {
      stage: 'body',
      timedOut: false,
      rangeRequested: true,
      status: 206,
      errorCode: 'NetworkError',
      networkCode: 'ECONNRESET',
    });
  } finally {
    await registry.dispose();
  }
});

it('records a range response header timeout', async () => {
  vi.useFakeTimers();
  const { registry, storage, ref, request, event } = await fixture(
    (init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () =>
          reject(new DOMException('Aborted', 'AbortError')),
        );
      }),
  );
  try {
    const failed = expect(storage.read(ref, { range: { offset: 4 } })).rejects.toMatchObject({
      code: 'NetworkError',
    });
    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(2));
    await vi.advanceTimersByTimeAsync(20_000);
    await failed;
    expect(event).toHaveBeenCalledExactlyOnceWith('google-drive.request.failed', {
      stage: 'headers',
      timedOut: true,
      rangeRequested: true,
      errorCode: 'NetworkError',
    });
  } finally {
    vi.useRealTimers();
    await registry.dispose();
  }
});

it('identifies metadata request failures before a resumed content request can start', async () => {
  const { registry, storage, ref, request, event } = await fixture(() => new Response('unused'));
  request.mockRejectedValueOnce(new TypeError('fetch failed', { cause: { code: 'ENOTFOUND' } }));
  try {
    await expect(storage.read(ref, { range: { offset: 4 } })).rejects.toMatchObject({
      code: 'NetworkError',
    });
    expect(request).toHaveBeenCalledOnce();
    expect(event).toHaveBeenCalledExactlyOnceWith('google-drive.request.failed', {
      stage: 'metadata',
      timedOut: false,
      errorCode: 'NetworkError',
      networkCode: 'ENOTFOUND',
    });
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

it.each([undefined, 2])(
  'requests an exact byte range and preserves its response length; length: %s',
  async (length) => {
    const body = length === undefined ? 'ent' : 'en';
    const { registry, storage, ref, request } = await fixture(
      () =>
        new Response(body, {
          status: 206,
          headers: { 'Content-Range': `bytes 4-${length === undefined ? 6 : 5}/7` },
        }),
      { size: '7', sha256Checksum: 'a'.repeat(64), md5Checksum: 'b'.repeat(32) },
    );
    try {
      const handle = await storage.read(ref, {
        range: { offset: 4, ...(length !== undefined ? { length } : {}) },
      });
      expect(handle.length).toBe(body.length);
      const chunks: Buffer[] = [];
      for await (const chunk of handle.stream) chunks.push(chunk as Buffer);
      expect(Buffer.concat(chunks).toString()).toBe(body);
      const media = request.mock.calls.find(
        ([input]) =>
          new URL(input instanceof Request ? input.url : input).searchParams.get('alt') === 'media',
      );
      expect(new Headers(media?.[1]?.headers).get('range')).toBe(
        length === undefined ? 'bytes=4-' : 'bytes=4-5',
      );
      expect((await storage.stat(ref)).checksums).toEqual([
        { algorithm: 'sha256', value: 'a'.repeat(64) },
        { algorithm: 'md5', value: 'b'.repeat(32) },
      ]);
    } finally {
      await registry.dispose();
    }
  },
);

it.each([
  { status: 200, headers: {} },
  { status: 206, headers: { 'Content-Range': 'bytes 0-6/7' } },
  { status: 206, headers: { 'Content-Range': 'bytes 4-7/7' } },
  { status: 206, headers: { 'Content-Range': 'bytes 4-5/7' } },
  { status: 206, headers: { 'Content-Range': 'bytes 4-6/7', 'Content-Length': '7' } },
  { status: 206, headers: { 'Content-Range': 'bytes 4-6/7', 'Content-Encoding': 'gzip' } },
])('rejects an ignored or invalid range response: %j', async ({ status, headers }) => {
  const cancel = vi.fn();
  const { registry, storage, ref } = await fixture(
    () => new Response(new ReadableStream({ cancel }), { status, headers }),
  );
  try {
    await expect(storage.read(ref, { range: { offset: 4 } })).rejects.toMatchObject({
      code: 'OutcomeUnknown',
    });
    expect(cancel).toHaveBeenCalledOnce();
  } finally {
    await registry.dispose();
  }
});
