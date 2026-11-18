import { createHash } from 'node:crypto';
import { mkdtempDisposable, readFile } from 'node:fs/promises';
import { createServer, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { AdapterRegistry, StorageAccess } from '../storage';
import { googleDriveAdapterFactory } from '../storage/providers/google-drive/google-drive-adapter';
import { DownloadService } from './download-service';

it('resumes a paused Drive download over HTTP with a fresh signal and the saved byte offset', async () => {
  await using temporary = await mkdtempDisposable(join(tmpdir(), 'terra-drive-resume-'));
  const content = Buffer.alloc(256 * 1024, 7);
  const prefixLength = 64 * 1024;
  const ranges: (string | undefined)[] = [];
  let initialResponse: ServerResponse | undefined;
  const file = {
    id: 'file',
    name: 'file.bin',
    mimeType: 'application/octet-stream',
    size: String(content.length),
    sha256Checksum: createHash('sha256').update(content).digest('hex'),
    capabilities: { canDownload: true },
  };
  const server = createServer((request, response) => {
    expect(request.headers.authorization).toBe('Bearer access');
    const url = new URL(request.url ?? '/', 'http://localhost');
    if (url.searchParams.get('alt') !== 'media') {
      response.setHeader('Content-Type', 'application/json');
      response.end(JSON.stringify(file));
      return;
    }
    const range = request.headers.range;
    ranges.push(range);
    if (!range) {
      initialResponse = response;
      response.writeHead(200, { 'Content-Length': content.length });
      response.write(content.subarray(0, prefixLength));
      return;
    }
    const offset = Number(/^bytes=(\d+)-$/.exec(range)?.[1]);
    response.writeHead(206, {
      'Content-Range': `bytes ${offset}-${content.length - 1}/${content.length}`,
      'Content-Length': content.length - offset,
    });
    response.end(content.subarray(offset));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing HTTP server port');
  const request: typeof fetch = (input, init) => {
    const url = new URL(input instanceof Request ? input.url : input);
    return fetch(`http://127.0.0.1:${address.port}${url.pathname}${url.search}`, init);
  };
  const event = vi.fn();
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
  const storage = new StorageAccess(registry, { async load() {}, async save() {} });
  const service = new DownloadService({
    stat: (ref, context) => storage.stat(ref, context),
    read: (ref, options, context) => storage.read(ref, options, context),
  });
  try {
    await registry.connect({
      id: 'account',
      provider: 'google-drive',
      configuration: { subject: 'subject', oauthClientId: 'client' },
      credentialRef: 'credential',
    });
    const prepared = await prepareExecution(service, 1, {
      ref: { connectionId: 'account', spaceId: 'my-drive', locator: file.id },
      directory: temporary.path,
      expectedName: file.name,
      replace: false,
    });
    const first = service.run(1, prepared.id, () => {}, 'first');
    await vi.waitFor(async () => expect(await readFile(prepared.path)).toHaveLength(prefixLength));
    await service.pause(1, prepared.id);
    expect(await first).toMatchObject({ status: 'paused', completedBytes: prefixLength });
    await vi.waitFor(() => expect(initialResponse?.destroyed).toBe(true));
    expect(await service.run(1, prepared.id, () => {}, 'second')).toEqual({ status: 'completed' });
    expect(ranges).toEqual([undefined, `bytes=${prefixLength}-`]);
    expect(await readFile(prepared.path)).toEqual(content);
    expect(event).not.toHaveBeenCalled();
  } finally {
    await service.dispose();
    await registry.dispose();
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});

async function prepareExecution(
  service: DownloadService,
  owner: number,
  request: Parameters<DownloadService['prepare']>[1],
) {
  const work = await service.prepare(owner, request);
  return service.resolveWork(owner, work.ref);
}
