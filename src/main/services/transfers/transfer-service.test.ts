import { createHash } from 'node:crypto';
import { mkdir, mkdtempDisposable, readdir, readFile, rename, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { AdapterRegistry, StorageAccess } from '@main/storage';
import { googleDriveAdapterFactory } from '@main/storage/providers/google-drive/google-drive-adapter';
import { localAdapterFactory, localSpace } from '@main/storage/providers/local/local-adapter';
import { createLocalPlatform } from '@main/storage/providers/local/local-platform';
import type { Entry, EntryRef } from '@shared/storage';
import type { StorageProvider } from '@shared/storage-browser';
import { createStorageDirectory } from '../storage/storage-directory';
import type { StorageEntryOperations } from '../storage/storage-entry-operations';
import { createStorageFile } from '../storage/storage-file';
import { TransferService } from './transfer-service';
import type { TransferOperations } from './transfer-types';

function buildOperations(
  storage: StorageAccess,
  providers: Record<string, StorageProvider>,
  semanticsByConn: Record<string, { allowsDuplicateNames: boolean; caseSensitive: boolean }>,
  validateEntryName?: (connectionId: string, name: string) => Promise<boolean>,
): TransferOperations {
  const ops: TransferOperations & Partial<StorageEntryOperations> = {
    spaceSemantics: async (ref: EntryRef) => semanticsByConn[ref.connectionId],
    spaceCapabilities: (ref: EntryRef, ctx) =>
      storage.capabilities(
        { kind: 'space', connectionId: ref.connectionId, spaceId: ref.spaceId },
        ctx,
      ),
    statEntry: (ref: EntryRef, ctx) => storage.stat(ref, ctx),
    listDirectory: (parent: EntryRef, req, ctx) =>
      storage.list(parent, typeof req === 'string' ? { cursor: req } : req, ctx),
    readEntry: (ref: EntryRef, opts, ctx) => storage.read(ref, opts, ctx),
    openDirectoryScope: (root: EntryRef, ctx) => storage.openDirectoryScope(root, ctx),
    createDirectory: (target, ctx) => storage.createDirectory(target, ctx),
    writeEntry: (target, source, ctx, opts) => storage.write(target, source, ctx, opts),
    prepareWrite: (target, source, opts) => storage.createWriteSession(target, source, opts),
    copyWithin: (ref, target, ctx) => storage.copyWithin(ref, target, ctx),
    moveWithin: (ref, target, ctx) => storage.moveWithin(ref, target, ctx),
    renameEntry: (ref, name, ctx) => storage.rename(ref, name, ctx),
    deleteEntry: (ref, ctx, opts) => storage.remove(ref, ctx, opts),
    directory: (ref: EntryRef) =>
      createStorageDirectory(ops as unknown as StorageEntryOperations, ref),
    file: (ref: EntryRef) => createStorageFile(ops as unknown as StorageEntryOperations, ref),
    resolveProvider: async (connectionId: string) => providers[connectionId] ?? 'local',
    ...(validateEntryName ? { validateEntryName } : {}),
  };
  return ops;
}

describe('TransferService cross-source transfers', () => {
  it.each(['session', 'one-shot'])('%s writes and move cleanup', async (writeMode) => {
    await using srcTmp = await mkdtempDisposable(join(tmpdir(), 'terra-xfer-src-'));
    await using dstTmp = await mkdtempDisposable(join(tmpdir(), 'terra-xfer-dst-'));
    await mkdir(join(srcTmp.path, 'docs'));
    await writeFile(join(srcTmp.path, 'docs', 'a.txt'), 'new-content');
    await writeFile(join(srcTmp.path, 'docs', 'b.txt'), 'created-content');
    await mkdir(join(dstTmp.path, 'docs'));
    await writeFile(join(dstTmp.path, 'docs', 'a.txt'), 'old-content');

    const platform = createLocalPlatform();
    const registry = new AdapterRegistry({
      credentials: { async resolve() {} },
      logger: { event() {} },
    });
    registry.register(localAdapterFactory(async () => [srcTmp.path, dstTmp.path], platform));
    await registry.connect({ id: 'src-conn', provider: 'local', configuration: {} });
    await registry.connect({ id: 'dst-conn', provider: 'local', configuration: {} });

    const storage = new StorageAccess(registry);
    const ops = buildOperations(
      storage,
      { 'src-conn': 'local', 'dst-conn': 'local' },
      {
        'src-conn': { allowsDuplicateNames: false, caseSensitive: platform.caseSensitive },
        'dst-conn': { allowsDuplicateNames: false, caseSensitive: platform.caseSensitive },
      },
      async (_conn, name) => platform.isValidEntryName(name),
    );
    if (writeMode === 'one-shot') {
      ops.statEntry = async (ref, context) => {
        const entry = await storage.stat(ref, context);
        if (ref.connectionId !== 'src-conn' || entry.kind !== 'file') return entry;
        return {
          ...entry,
          capabilities: { ...entry.capabilities, rangeRead: { support: 'unsupported' } },
        };
      };
    }
    const service = new TransferService(ops);
    const srcRoot = localSpace('src-conn', srcTmp.path, platform).root;
    const dstRoot = localSpace('dst-conn', dstTmp.path, platform).root;

    try {
      const docsEntry = await storage.stat({ ...srcRoot, locator: 'docs' });
      const prepared = await service.prepare(1, {
        mode: 'move',
        sourceParent: srcRoot,
        targetParent: dstRoot,
        entries: [docsEntry],
      });
      expect(prepared.kind).toBe('batch');
      if (prepared.kind !== 'batch') return;
      expect(prepared.prepared.conflicts).toEqual(['docs']);

      // Unconfirmed plan rejects discovery.
      await expect(service.discoverDirectory(1, prepared.prepared.id, 0, 0)).rejects.toMatchObject({
        code: 'AlreadyExists',
      });

      service.confirmPlan(1, prepared.prepared.id);
      const page = await service.discoverDirectory(1, prepared.prepared.id, 0, 0);
      expect(page.items).toHaveLength(2);
      for (const child of page.items) {
        const work = { planId: prepared.prepared.id, itemId: child.id };
        const result = await service.runWork(1, work, {
          signal: new AbortController().signal,
          onProgress: () => {},
        });
        expect(result.status).toBe('completed');
        expect(service.getCommittedFile(1, work)).toMatchObject({ sourceDeleted: false });
      }
      expect(await readFile(join(dstTmp.path, 'docs', 'a.txt'), 'utf8')).toBe('new-content');
      expect(await readFile(join(dstTmp.path, 'docs', 'b.txt'), 'utf8')).toBe('created-content');

      expect(service.getRemainingSourceDirectories(1, prepared.prepared.id)).toHaveLength(1);

      service.finishPlan(1, prepared.prepared.id);
      await service.releasePlan(1, prepared.prepared.id);
    } finally {
      await service.dispose();
      await registry.dispose();
    }
  });

  it('rejects replaced target directory before opening source stream', async () => {
    await using srcTmp = await mkdtempDisposable(join(tmpdir(), 'terra-xfer-guard-src-'));
    await using dstTmp = await mkdtempDisposable(join(tmpdir(), 'terra-xfer-guard-dst-'));
    await mkdir(join(srcTmp.path, 'A'));
    await writeFile(join(srcTmp.path, 'A', 'file.txt'), 'payload');

    const platform = createLocalPlatform();
    const registry = new AdapterRegistry({
      credentials: { async resolve() {} },
      logger: { event() {} },
    });
    registry.register(localAdapterFactory(async () => [srcTmp.path, dstTmp.path], platform));
    await registry.connect({ id: 'src-conn', provider: 'local', configuration: {} });
    await registry.connect({ id: 'dst-conn', provider: 'local', configuration: {} });

    const storage = new StorageAccess(registry);
    const readSpy = vi.spyOn(storage, 'read');
    const ops = buildOperations(
      storage,
      { 'src-conn': 'local', 'dst-conn': 'local' },
      {
        'src-conn': { allowsDuplicateNames: false, caseSensitive: platform.caseSensitive },
        'dst-conn': { allowsDuplicateNames: false, caseSensitive: platform.caseSensitive },
      },
    );
    const service = new TransferService(ops);
    const srcRoot = localSpace('src-conn', srcTmp.path, platform).root;
    const dstRoot = localSpace('dst-conn', dstTmp.path, platform).root;

    try {
      const dirEntry = await storage.stat({ ...srcRoot, locator: 'A' });
      const prepared = await service.prepare(1, {
        mode: 'copy',
        sourceParent: srcRoot,
        targetParent: dstRoot,
        entries: [dirEntry],
      });
      if (prepared.kind !== 'batch') throw new Error('Expected batch');
      const page = await service.discoverDirectory(1, prepared.prepared.id, 0, 0);
      const fileItem = page.items[0]!;

      // Swap A on disk before file runs.
      await rename(join(dstTmp.path, 'A'), join(dstTmp.path, 'A-moved'));
      await mkdir(join(dstTmp.path, 'A'));
      await writeFile(join(dstTmp.path, 'A', 'file.txt'), 'external');

      await expect(
        service.runWork(
          1,
          { planId: prepared.prepared.id, itemId: fileItem.id },
          { signal: new AbortController().signal, onProgress: () => {} },
        ),
      ).rejects.toMatchObject({ code: 'PreconditionFailed' });
      expect(readSpy).not.toHaveBeenCalled();
      expect(await readFile(join(dstTmp.path, 'A', 'file.txt'), 'utf8')).toBe('external');
      await service.releasePlan(1, prepared.prepared.id);
      expect(await readdir(join(dstTmp.path, 'A'))).toEqual(['file.txt']);
    } finally {
      await service.dispose();
      await registry.dispose();
    }
  });

  it('transfers cloud-to-cloud across two Google Drive connections with checksum verification', async () => {
    const content = Buffer.from('cloud-to-cloud-payload');
    const sha256 = createHash('sha256').update(content).digest('hex');
    const uploadedChunks: Buffer[] = [];
    const sessionUrl = 'https://www.googleapis.com/upload/drive/v3/files?upload_id=c2c';

    const request = vi.fn<typeof fetch>(async (input, init) => {
      const call = new Request(input, init);
      const url = new URL(call.url);
      if (url.pathname === '/drive/v3/files/src-file' && url.searchParams.get('alt') === 'media') {
        const rangeHeader = call.headers.get('Range');
        if (rangeHeader) {
          const match = /^bytes=(\d+)-(\d*)$/.exec(rangeHeader)!;
          const start = Number(match[1]);
          const end = match[2] ? Number(match[2]) : content.length - 1;
          const slice = content.subarray(start, end + 1);
          return new Response(slice, {
            status: 206,
            headers: {
              'Content-Range': `bytes ${start}-${end}/${content.length}`,
              'Content-Length': String(slice.length),
            },
          });
        }
        return new Response(content, {
          status: 200,
          headers: { 'Content-Length': String(content.length) },
        });
      }
      if (url.pathname === '/drive/v3/files/src-file') {
        return Response.json({
          id: 'src-file',
          name: 'report.txt',
          mimeType: 'text/plain',
          size: String(content.length),
          sha256Checksum: sha256,
          capabilities: { canDownload: true, canTrash: true },
        });
      }
      if (url.pathname === '/drive/v3/files/root') {
        return Response.json({
          id: 'root',
          name: 'My Drive',
          mimeType: 'application/vnd.google-apps.folder',
          capabilities: { canAddChildren: true },
        });
      }
      if (url.pathname === '/drive/v3/files/generateIds') {
        return Response.json({ ids: ['dst-file'] });
      }
      if (url.pathname === '/upload/drive/v3/files') {
        if (call.method === 'POST') {
          return new Response(null, { headers: { Location: sessionUrl } });
        }
        uploadedChunks.push(Buffer.from(await call.arrayBuffer()));
        return Response.json({
          id: 'dst-file',
          name: 'report.txt',
          mimeType: 'text/plain',
          size: String(content.length),
          sha256Checksum: sha256,
          parents: ['root'],
        });
      }
      throw new Error('Unexpected Drive request: ' + url.toString());
    });

    const registry = new AdapterRegistry({
      credentials: {
        async resolve(ref) {
          return {
            provider: 'google-drive',
            connectionId: ref === 'cred-a' ? 'drive-a' : 'drive-b',
            subject: ref,
            oauthClientId: 'client',
            getAccessToken: async () => 'token-' + ref,
          };
        },
      },
      logger: { event() {} },
    });
    registry.register(googleDriveAdapterFactory(request));
    await registry.connect({
      id: 'drive-a',
      provider: 'google-drive',
      configuration: { subject: 'cred-a', oauthClientId: 'client' },
      credentialRef: 'cred-a',
    });
    await registry.connect({
      id: 'drive-b',
      provider: 'google-drive',
      configuration: { subject: 'cred-b', oauthClientId: 'client' },
      credentialRef: 'cred-b',
    });

    const storage = new StorageAccess(registry);
    const ops = buildOperations(
      storage,
      { 'drive-a': 'google-drive', 'drive-b': 'google-drive' },
      {
        'drive-a': { allowsDuplicateNames: true, caseSensitive: true },
        'drive-b': { allowsDuplicateNames: true, caseSensitive: true },
      },
    );
    const service = new TransferService(ops);

    try {
      const srcParent: EntryRef = { connectionId: 'drive-a', spaceId: 'my-drive', locator: 'root' };
      const dstParent: EntryRef = { connectionId: 'drive-b', spaceId: 'my-drive', locator: 'root' };
      const srcEntry: Entry = await storage.stat({ ...srcParent, locator: 'src-file' });

      const prepared = await service.prepare(1, {
        mode: 'copy',
        sourceParent: srcParent,
        targetParent: dstParent,
        entries: [srcEntry],
      });
      expect(prepared.kind).toBe('single');
      if (prepared.kind !== 'single') return;
      expect(prepared.conflicts).toEqual([]);

      const result = await service.runWork(1, prepared.work.ref, {
        signal: new AbortController().signal,
        onProgress: () => {},
      });
      expect(result.status).toBe('completed');
      expect(Buffer.concat(uploadedChunks)).toEqual(content);
      await service.releaseWork(1, prepared.work.ref);
    } finally {
      await service.dispose();
      await registry.dispose();
    }
  });

  it('rejects one-shot source against Drive target during prepare before enqueueing', async () => {
    const ops: TransferOperations = {
      directory: (ref) =>
        ({
          ref,
          capabilities: async () => ({
            write: { support: 'supported' },
            streamingWrite: { support: 'unsupported' },
            pausableWrite: { support: 'supported' },
            replaceWrite: { support: 'unsupported' },
          }),
          semantics: async () => ({ allowsDuplicateNames: true, caseSensitive: true }),
        }) as unknown as ReturnType<TransferOperations['directory']>,
      file: () => {
        throw new Error('unused');
      },
      statEntry: async () => {
        throw new Error('unused');
      },
      deleteEntry: async () => {},
      resolveProvider: async (id) => (id === 'drive' ? 'google-drive' : 'local'),
    };
    const service = new TransferService(ops);
    const oneShotEntry: Entry = {
      ref: { connectionId: 'src', spaceId: 's', locator: 'stream' },
      name: 'live.bin',
      kind: 'file',
      capabilities: {
        read: { support: 'supported' },
        rangeRead: { support: 'unsupported' },
      },
    };
    await expect(
      service.prepare(1, {
        mode: 'copy',
        sourceParent: { connectionId: 'src', spaceId: 's', locator: '.' },
        targetParent: { connectionId: 'drive', spaceId: 'my-drive', locator: 'root' },
        entries: [oneShotEntry],
      }),
    ).rejects.toMatchObject({ code: 'Unsupported' });
    await service.dispose();
  });
});
