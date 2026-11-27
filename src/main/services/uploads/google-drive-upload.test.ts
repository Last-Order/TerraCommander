import { createHash } from 'node:crypto';
import { mkdtempDisposable, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { afterEach, expect, it, vi } from 'vitest';
import { AdapterRegistry, StorageAccess } from '@main/storage';
import { googleDriveAdapterFactory } from '@main/storage/providers/google-drive/google-drive-adapter';
import { prepareLocalUpload } from './local-upload-source';

const parent = { connectionId: 'account', spaceId: 'my-drive', locator: 'root' };
const session = 'https://www.googleapis.com/upload/drive/v3/files?upload_id=test';
const chunkSize = 8 * 1024 * 1024;
const registries: AdapterRegistry[] = [];
afterEach(async () => {
  await Promise.all(registries.splice(0).map((registry) => registry.dispose()));
});

async function setup(
  media: (request: Request) => Response | Promise<Response>,
  options: { canWrite?: boolean; recovered?: object } = {},
) {
  const request = vi.fn<typeof fetch>(async (input, init) => {
    const call = new Request(input, init);
    const url = new URL(call.url);
    switch (url.pathname) {
      case '/drive/v3/files/root':
        return Response.json({
          id: 'root-id',
          name: 'My Drive',
          mimeType: 'application/vnd.google-apps.folder',
          capabilities: { canAddChildren: options.canWrite ?? true },
        });
      case '/drive/v3/files/generateIds':
        return Response.json({ ids: ['new-id'] });
      case '/drive/v3/files/new-id':
        return options.recovered
          ? Response.json(options.recovered)
          : new Response(null, { status: 404 });
      case '/upload/drive/v3/files':
        return call.method === 'POST'
          ? new Response(null, { headers: { Location: session } })
          : media(call);
      default:
        throw new Error('Unexpected Drive request');
    }
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
  registries.push(registry);
  registry.register(googleDriveAdapterFactory(request));
  await registry.connect({
    id: 'account',
    provider: 'google-drive',
    configuration: { subject: 'subject', oauthClientId: 'client' },
    credentialRef: 'credential',
  });
  return { storage: new StorageAccess(registry), request };
}

async function createLocalSource(path: string, content: Uint8Array) {
  await writeFile(path, content);
  const { name, source } = await prepareLocalUpload(path);
  return { target: { kind: 'create', policy: 'create-only', parent, name } as const, source };
}

function file(size: number) {
  return {
    id: 'new-id',
    name: 'example.bin',
    mimeType: 'application/octet-stream',
    size: String(size),
    parents: ['root-id'],
  };
}

it('checks the confirmed range after an interruption before sending the remaining bytes', async () => {
  await using temporary = await mkdtempDisposable(join(tmpdir(), 'terra-upload-'));
  const content = Buffer.alloc(chunkSize + 3, 7);
  const { target, source } = await createLocalSource(join(temporary.path, 'example.bin'), content);
  const confirmed = 256 * 1024;
  const ranges: Array<string | null> = [];
  const media = async (request: Request) => {
    const range = request.headers.get('Content-Range');
    ranges.push(range);
    if (ranges.length === 1) throw new TypeError('connection interrupted');
    if (ranges.length === 2) {
      return new Response(null, { status: 308, headers: { Range: `bytes=0-${confirmed - 1}` } });
    }
    expect(Buffer.from(await request.arrayBuffer()).equals(content.subarray(confirmed))).toBe(true);
    return Response.json(file(content.length));
  };
  const { storage, request } = await setup(media);
  const onProgress = vi.fn();
  await expect(storage.write(target, source, { onProgress })).resolves.toMatchObject({
    ref: { ...parent, locator: 'new-id' },
    size: content.length,
  });
  expect(ranges).toEqual([
    `bytes 0-${chunkSize - 1}/${content.length}`,
    `bytes */${content.length}`,
    `bytes ${confirmed}-${content.length - 1}/${content.length}`,
  ]);
  expect(onProgress).toHaveBeenNthCalledWith(
    1,
    expect.objectContaining({ confirmedBytes: confirmed }),
  );
  expect(onProgress).toHaveBeenLastCalledWith(
    expect.objectContaining({ confirmedBytes: content.length }),
  );
  const start = request.mock.calls.find(([, init]) => init?.method === 'POST');
  expect(start?.[1]?.body).toBe(
    JSON.stringify({ id: 'new-id', name: target.name, parents: ['root-id'] }),
  );
});

it.each([true, false])(
  'reconciles a lost final response before settling (found=%s)',
  async (found) => {
    await using temporary = await mkdtempDisposable(join(tmpdir(), 'terra-upload-'));
    const { target, source } = await createLocalSource(
      join(temporary.path, 'example.bin'),
      Buffer.from('data'),
    );
    const controller = new AbortController();
    const media = vi
      .fn<(request: Request) => Promise<Response>>()
      .mockImplementationOnce(async () => {
        controller.abort();
        throw new TypeError('final response lost');
      })
      .mockResolvedValueOnce(new Response(null, { status: 404 }));
    const { storage, request } = await setup(media, found ? { recovered: file(4) } : {});
    const result = storage.write(target, source, { signal: controller.signal });
    if (found) await expect(result).resolves.toMatchObject({ ref: { locator: 'new-id' } });
    else
      await expect(result).rejects.toMatchObject({
        code: 'OutcomeUnknown',
        retryHint: 'after-reconciliation',
      });
    expect(media).toHaveBeenCalledTimes(2);
    expect(request.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1);
  },
);

it('uploads a zero-byte file with the empty content range', async () => {
  await using temporary = await mkdtempDisposable(join(tmpdir(), 'terra-upload-'));
  const { target, source } = await createLocalSource(
    join(temporary.path, 'example.bin'),
    Buffer.alloc(0),
  );
  const media = vi.fn((request: Request) => {
    expect(request.headers.get('Content-Range')).toBe('bytes */0');
    expect(request.headers.get('Content-Length')).toBe('0');
    return Response.json(file(0));
  });
  const { storage } = await setup(media);
  await expect(storage.write(target, source)).resolves.toMatchObject({ size: 0 });
  expect(media).toHaveBeenCalledTimes(1);
});

it('rejects a changed source and a read-only destination before sending content', async () => {
  await using temporary = await mkdtempDisposable(join(tmpdir(), 'terra-upload-'));
  const path = join(temporary.path, 'example.bin');
  const { target, source } = await createLocalSource(path, Buffer.from('before'));
  const media = vi.fn(() => Response.json(file(6)));
  const allowed = await setup(media);
  const readOnly = await setup(media, { canWrite: false });
  await expect(readOnly.storage.write(target, source)).rejects.toMatchObject({
    code: 'PermissionDenied',
  });
  await writeFile(path, 'changed');
  await expect(allowed.storage.write(target, source)).rejects.toMatchObject({
    code: 'SourceChanged',
  });
  expect(media).not.toHaveBeenCalled();
});

it.each(['resume', 'completed', 'changed'] as const)(
  'settles a pause during the final upload request (%s)',
  async (outcome) => {
    await using temporary = await mkdtempDisposable(join(tmpdir(), 'terra-upload-'));
    const path = join(temporary.path, 'example.bin');
    const content = Buffer.alloc(256 * 1024, 7);
    const { target, source } = await createLocalSource(path, content);
    const pause = new AbortController();
    const ranges: Array<string | null> = [];
    const firstChunk = 64 * 1024;
    const { storage, request } = await setup(async (call) => {
      const range = call.headers.get('Content-Range');
      ranges.push(range);
      if (ranges.length === 1) {
        const reader = call.body!.getReader();
        expect((await reader.read()).value).toHaveLength(firstChunk);
        pause.abort();
        await reader.cancel();
        throw new DOMException('Paused', 'AbortError');
      }
      if (range === `bytes */${content.length}`) {
        return outcome === 'completed'
          ? Response.json(file(content.length))
          : new Response(null, { status: 308, headers: { Range: `bytes=0-${firstChunk - 1}` } });
      }
      expect(Buffer.from(await call.arrayBuffer()).equals(content.subarray(firstChunk))).toBe(true);
      return Response.json(file(content.length));
    });
    const execution = storage.createWriteSession(target, source);
    const onBytesSent = vi.fn<(count: number) => void>();
    const onProgress = vi.fn();
    const running = execution.run({ pauseSignal: pause.signal, onBytesSent, onProgress });
    if (outcome === 'completed') {
      await expect(running).resolves.toMatchObject({ ref: { locator: 'new-id' } });
    } else {
      await expect(running).rejects.toMatchObject({ code: 'Cancelled' });
      expect(onProgress).toHaveBeenLastCalledWith(
        expect.objectContaining({ confirmedBytes: firstChunk }),
      );
      if (outcome === 'changed') {
        await writeFile(path, 'source changed');
        await expect(execution.run({})).rejects.toMatchObject({ code: 'SourceChanged' });
      } else {
        await expect(execution.run({ onBytesSent, onProgress })).resolves.toMatchObject({
          ref: { locator: 'new-id' },
        });
        expect(ranges.at(-1)).toBe(`bytes ${firstChunk}-${content.length - 1}/${content.length}`);
      }
    }
    expect(ranges[1]).toBe(`bytes */${content.length}`);
    expect(onBytesSent).toHaveBeenNthCalledWith(1, firstChunk);
    expect(request.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1);
  },
);

it('reports Cancelled instead of OutcomeUnknown when cancelled during the final chunk', async () => {
  await using temporary = await mkdtempDisposable(join(tmpdir(), 'terra-upload-cancel-'));
  const content = Buffer.alloc(128 * 1024, 5);
  const { target, source } = await createLocalSource(join(temporary.path, 'example.bin'), content);
  const cancel = new AbortController();
  const { storage, request } = await setup(async (call) => {
    const reader = call.body!.getReader();
    await reader.read();
    cancel.abort();
    await reader.cancel();
    throw new DOMException('Cancelled', 'AbortError');
  });
  const execution = storage.createWriteSession(target, source);
  const pause = new AbortController();
  await expect(
    execution.run({ signal: cancel.signal, pauseSignal: pause.signal }),
  ).rejects.toMatchObject({
    code: 'Cancelled',
  });
  expect(
    request.mock.calls.filter(([input]) => {
      const raw = input instanceof Request ? input.url : input;
      return new URL(raw).pathname === '/drive/v3/files/new-id';
    }),
  ).toHaveLength(0);
});

it('verifies returned Drive sha256Checksum and uses source.verify on strong-source resume', async () => {
  const content = Buffer.from('0123456789abcdef');
  const sha256 = createHash('sha256').update(content).digest('hex');
  const verify = vi.fn(async () => true);
  const openCalls: Array<{ offset: number; length?: number } | undefined> = [];
  const source = {
    kind: 'reopenable' as const,
    size: content.length,
    descriptor: {
      identity: 'remote-src',
      revision: sha256,
      size: content.length,
      verification: 'strong' as const,
      checksum: { algorithm: 'sha256', value: sha256 },
    },
    verify,
    async open(range?: { offset: number; length?: number }) {
      openCalls.push(range);
      const start = range?.offset ?? 0;
      const end = range?.length !== undefined ? start + range.length : content.length;
      const slice = content.subarray(start, end);
      const stream = Readable.from([slice], { objectMode: false });
      return { stream, length: slice.length, dispose: async () => {} };
    },
  };
  let returnedSha = sha256;
  let attempts = 0;
  const pause = new AbortController();
  const { storage } = await setup(async (call) => {
    attempts += 1;
    const range = call.headers.get('Content-Range');
    if (attempts === 1) {
      pause.abort();
      throw new DOMException('Paused', 'AbortError');
    }
    if (range === `bytes */${content.length}`) {
      return new Response(null, { status: 308, headers: { Range: 'bytes=0-3' } });
    }
    return Response.json({ ...file(content.length), sha256Checksum: returnedSha });
  });
  const target = {
    kind: 'create' as const,
    policy: 'create-only' as const,
    parent,
    name: 'example.bin',
  };
  const exec = storage.createWriteSession(target, source);
  await expect(exec.run({ pauseSignal: pause.signal })).rejects.toMatchObject({
    code: 'Cancelled',
  });
  await expect(exec.run({})).resolves.toMatchObject({ size: content.length });
  expect(verify).toHaveBeenCalledOnce();
  // Strong verification should not re-read prefix [0..4) over the network on resume.
  expect(openCalls.filter((r) => r?.offset === 0 && r.length === 4)).toHaveLength(0);

  // Mismatched Drive sha256Checksum must reject as SourceChanged.
  returnedSha = '0'.repeat(64);
  const bad = await setup(async () =>
    Response.json({ ...file(content.length), sha256Checksum: returnedSha }),
  );
  await expect(bad.storage.write(target, source)).rejects.toMatchObject({ code: 'SourceChanged' });
});
