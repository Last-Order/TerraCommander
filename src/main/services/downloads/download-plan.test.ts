import {
  mkdir,
  mkdtempDisposable,
  readFile,
  readdir,
  rename,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough, Readable } from 'node:stream';
import { expect, it, vi } from 'vitest';
import type { DownloadPlanItem, PreparedDownloadBatch } from './download-types';
import type { Entry } from '@shared/storage';
import { StorageError } from '@main/storage/core/errors';
import { DownloadService } from './download-service';
import type { DownloadSource } from './download-transfer';

function entry(locator: string, name: string, kind: Entry['kind'] = 'file'): Entry {
  return {
    ref: { connectionId: 'account', spaceId: 'drive', locator },
    name,
    kind,
    capabilities: {},
  };
}

function fixture(
  directory: string,
  roots: Entry[],
  children: Record<string, Entry[]> = {},
  overrides: Partial<DownloadSource> = {},
) {
  const entries = new Map(
    [...roots, ...Object.values(children).flat()].map((value) => [value.ref.locator, value]),
  );
  const read = vi.fn<DownloadSource['read']>(async (ref) => ({
    stream: Readable.from([Buffer.from(ref.locator)]),
    dispose: async () => {},
  }));
  const list = vi.fn<NonNullable<DownloadSource['list']>>(async (ref) => ({
    entries: children[ref.locator] ?? [],
  }));
  const service = new DownloadService({
    stat: async (ref) => entries.get(ref.locator)!,
    read,
    list,
    ...overrides,
  });
  const request = {
    directory,
    entries: roots.map((value) => ({ ref: value.ref, expectedName: value.name })),
  };
  return { service, request, read, list };
}

async function collect(
  service: DownloadService,
  prepared: PreparedDownloadBatch,
): Promise<DownloadPlanItem[]> {
  const result: DownloadPlanItem[] = [];
  const pending = [...prepared.items];
  for (let item = pending.shift(); item; item = pending.shift()) {
    if (item.entry.kind !== 'directory' || item.code) {
      result.push(item);
      continue;
    }
    let offset: number | undefined = 0;
    while (offset !== undefined) {
      const page = await service.discoverBatchDirectory(1, prepared.id, item.id, offset);
      pending.push(...page.items);
      offset = page.nextOffset;
    }
  }
  return result;
}

async function transfer(service: DownloadService, batchId: string, item: DownloadPlanItem) {
  const prepared = await service.resolveWork(1, { planId: batchId, itemId: item.id });
  await service.run(1, prepared.id, () => {});
}

it('only checks root conflicts and separates discovery from byte transfer', async () => {
  await using temporary = await mkdtempDisposable(join(tmpdir(), 'terra-plan-'));
  await mkdir(join(temporary.path, 'A'));
  await writeFile(join(temporary.path, 'A', 'same.txt'), 'old');
  await writeFile(join(temporary.path, 'A', 'local.txt'), 'keep');
  const { service, request, list, read } = fixture(
    temporary.path,
    [entry('folder', 'A', 'directory')],
    { folder: [entry('new content', 'same.txt'), entry('empty', 'Empty', 'directory')] },
  );
  const prepared = await service.prepareBatch(1, request);
  expect(prepared.conflicts).toEqual(['A']);
  expect(list).not.toHaveBeenCalled();
  await expect(service.discoverBatchDirectory(1, prepared.id, 0, 0)).rejects.toMatchObject({
    code: 'AlreadyExists',
  });
  service.confirmBatch(1, prepared.id);
  const files = await collect(service, prepared);
  expect(read).not.toHaveBeenCalled();
  await transfer(service, prepared.id, files[0]!);
  service.finishBatch(1, prepared.id);
  await service.releaseBatch(1, prepared.id);
  expect(await readFile(join(temporary.path, 'A', 'same.txt'), 'utf8')).toBe('new content');
  expect(await readFile(join(temporary.path, 'A', 'local.txt'), 'utf8')).toBe('keep');
  expect(await readdir(join(temporary.path, 'A', 'Empty'))).toEqual([]);
  await service.dispose();
});

it('numbers duplicate roots before checking local conflicts', async () => {
  await using temporary = await mkdtempDisposable(join(tmpdir(), 'terra-plan-'));
  await writeFile(join(temporary.path, 'report (1).txt'), 'old');
  const { service, request } = fixture(temporary.path, [
    entry('one', 'report.txt'),
    entry('two', 'report.txt'),
  ]);
  const prepared = await service.prepareBatch(1, request);
  expect(prepared.conflicts).toEqual(['report (1).txt']);
  service.confirmBatch(1, prepared.id);
  await Promise.all(prepared.items.map((item) => transfer(service, prepared.id, item)));
  expect(await readFile(join(temporary.path, 'report (1).txt'), 'utf8')).toBe('one');
  expect(await readFile(join(temporary.path, 'report (2).txt'), 'utf8')).toBe('two');
  await service.dispose();
});

it('reads every sibling page before numbering and caches names for repeated discovery', async () => {
  await using temporary = await mkdtempDisposable(join(tmpdir(), 'terra-plan-'));
  const children = [
    entry('one', 'report.txt'),
    entry('two', 'report.txt'),
    entry('three', 'report (1).txt'),
  ];
  const list = vi.fn<NonNullable<DownloadSource['list']>>(async (_ref, { cursor }) => {
    if (!cursor) return { entries: [children[0]!], nextCursor: 'empty' };
    if (cursor === 'empty') return { entries: [], nextCursor: 'last' };
    return { entries: children.slice(1) };
  });
  const { service, request } = fixture(
    temporary.path,
    [entry('folder', 'A', 'directory')],
    { folder: children },
    { list },
  );
  const prepared = await service.prepareBatch(1, request);
  const page = await service.discoverBatchDirectory(1, prepared.id, 0, 0);
  expect(page.items.map((item) => item.path)).toEqual(
    ['report (2).txt', 'report (3).txt', 'report (1).txt'].map((name) => join('A', name)),
  );
  expect(await service.discoverBatchDirectory(1, prepared.id, 0, 0)).toEqual(page);
  expect(list).toHaveBeenCalledTimes(3);
  await Promise.all(page.items.map((item) => transfer(service, prepared.id, item)));
  await service.dispose();
});

it('returns bounded pages of stable child descriptors without preparing transfers', async () => {
  await using temporary = await mkdtempDisposable(join(tmpdir(), 'terra-plan-'));
  const children = Array.from({ length: 70 }, (_, index) => entry(String(index), `${index}.txt`));
  const { service, request, read, list } = fixture(
    temporary.path,
    [entry('folder', 'A', 'directory')],
    { folder: children },
  );
  const prepared = await service.prepareBatch(1, request);
  expect(await service.discoverBatchDirectory(1, prepared.id, 0, 0)).toMatchObject({
    items: expect.any(Array),
    nextOffset: 32,
  });
  expect((await service.discoverBatchDirectory(1, prepared.id, 0, 32)).items).toHaveLength(32);
  expect((await service.discoverBatchDirectory(1, prepared.id, 0, 64)).items).toHaveLength(6);
  expect(list).toHaveBeenCalledOnce();
  expect(read).not.toHaveBeenCalled();
  await service.dispose();
});

it('rejects escaping names on every attempt while allowing other files to transfer', async () => {
  await using temporary = await mkdtempDisposable(join(tmpdir(), 'terra-plan-'));
  const { service, request, read } = fixture(temporary.path, [entry('folder', 'A', 'directory')], {
    folder: [
      entry('bad', '../../outside.txt'),
      entry('link', 'Shortcut', 'link'),
      entry('good', 'good.txt'),
    ],
  });
  const prepared = await service.prepareBatch(1, request);
  const files = await collect(service, prepared);
  for (let attempt = 0; attempt < 2; attempt++)
    await expect(
      service.resolveWork(1, { planId: prepared.id, itemId: files[0]!.id }),
    ).rejects.toMatchObject({
      code: 'InvalidDownloadName',
    });
  await expect(
    service.resolveWork(1, { planId: prepared.id, itemId: files[1]!.id }),
  ).rejects.toMatchObject({
    code: 'Unsupported',
  });
  await transfer(service, prepared.id, files[2]!);
  expect(read).toHaveBeenCalledOnce();
  expect(await readdir(temporary.path)).toEqual(['A']);
  await service.dispose();
});

it('allows parallel files and cancels one without interrupting its sibling', async () => {
  await using temporary = await mkdtempDisposable(join(tmpdir(), 'terra-plan-'));
  const streams = [new PassThrough(), new PassThrough()];
  const read = vi.fn<DownloadSource['read']>(async (ref) => {
    const stream = streams[Number(ref.locator)]!;
    return {
      stream,
      dispose: async () => {
        stream.destroy();
      },
    };
  });
  const { service, request } = fixture(
    temporary.path,
    [entry('0', 'one.txt'), entry('1', 'two.txt')],
    {},
    { read },
  );
  const prepared = await service.prepareBatch(1, request);
  const files = await Promise.all(
    prepared.items.map((item) => service.resolveWork(1, { planId: prepared.id, itemId: item.id })),
  );
  const runs = files.map((file) => service.run(1, file.id, () => {}));
  const rejected = expect(runs[0]).rejects.toMatchObject({ code: 'Cancelled' });
  await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(2));
  await service.cancelBatchItem(1, prepared.id, 0);
  await rejected;
  streams[1]!.end('kept');
  await runs[1];
  expect(await readdir(temporary.path)).toEqual(['two.txt']);
  await service.dispose();
});

it('holds subtree reservations until group settlement and reuses failed destination mappings', async () => {
  await using temporary = await mkdtempDisposable(join(tmpdir(), 'terra-plan-'));
  const { service, request, read } = fixture(temporary.path, [entry('folder', 'A', 'directory')], {
    folder: [entry('one', 'same.txt'), entry('two', 'same.txt')],
  });
  const prepared = await service.prepareBatch(1, request);
  const files = await collect(service, prepared);
  await transfer(service, prepared.id, files[0]!);
  read.mockRejectedValueOnce(new StorageError('NetworkError'));
  await expect(transfer(service, prepared.id, files[1]!)).rejects.toMatchObject({
    code: 'NetworkError',
  });
  const single = {
    directory: join(temporary.path, 'A'),
    ref: files[0]!.entry.ref,
    expectedName: 'same.txt',
    replace: false,
  };
  await expect(service.prepare(2, single)).rejects.toMatchObject({ code: 'DownloadTargetBusy' });
  service.finishBatch(1, prepared.id);
  await transfer(service, prepared.id, files[1]!);
  expect(read.mock.calls.map(([ref]) => ref.locator)).toEqual(['one', 'two', 'two']);
  expect(await readdir(join(temporary.path, 'A'))).toEqual(['same (1).txt', 'same (2).txt']);
  await service.dispose();
});

it('retries incomplete enumeration without publishing partial child lists', async () => {
  await using temporary = await mkdtempDisposable(join(tmpdir(), 'terra-plan-'));
  const child = entry('child', 'file.txt');
  const list = vi.fn<NonNullable<DownloadSource['list']>>(async () => ({
    entries: [child],
    nextCursor: 'repeat',
  }));
  const { service, request } = fixture(
    temporary.path,
    [entry('folder', 'A', 'directory')],
    { folder: [child] },
    { list },
  );
  const prepared = await service.prepareBatch(1, request);
  await expect(service.discoverBatchDirectory(1, prepared.id, 0, 0)).rejects.toMatchObject({
    code: 'OutcomeUnknown',
  });
  list.mockResolvedValue({ entries: [child] });
  const page = await service.discoverBatchDirectory(1, prepared.id, 0, 0);
  expect(page.items).toHaveLength(1);
  expect(page.items[0]!.path).toBe(join('A', 'file.txt'));
  await service.dispose();
});

it('aborts directory discovery when its task is cancelled and cleans an unfinished session', async () => {
  await using temporary = await mkdtempDisposable(join(tmpdir(), 'terra-plan-'));
  const list = vi.fn<NonNullable<DownloadSource['list']>>(async (_ref, _request, { signal }) => {
    await new Promise((_resolve, reject) =>
      signal?.addEventListener('abort', () => reject(new StorageError('Cancelled')), {
        once: true,
      }),
    );
    return { entries: [] };
  });
  const { service, request } = fixture(
    temporary.path,
    [entry('folder', 'A', 'directory')],
    {},
    { list },
  );
  const prepared = await service.prepareBatch(1, request);
  const discovering = service.discoverBatchDirectory(1, prepared.id, 0, 0);
  const rejected = expect(discovering).rejects.toMatchObject({ code: 'Cancelled' });
  await vi.waitFor(() => expect(list).toHaveBeenCalledOnce());
  await service.cancelBatchItem(1, prepared.id, 0);
  await rejected;
  await service.releaseBatch(1, prepared.id);
  expect(await readdir(temporary.path)).toEqual([]);
  await service.dispose();
});

it('rejects replaced directories before opening file streams', async () => {
  await using temporary = await mkdtempDisposable(join(tmpdir(), 'terra-plan-'));
  const root = entry('folder', 'A', 'directory');
  const child = entry('child', 'file.txt');
  const stat: DownloadSource['stat'] = async (ref) => {
    if (ref.locator === root.ref.locator) return root;
    await rename(join(temporary.path, 'A'), join(temporary.path, 'moved'));
    await mkdir(join(temporary.path, 'A'));
    await writeFile(join(temporary.path, 'A', 'file.txt'), 'external');
    return child;
  };
  const { service, request, read } = fixture(temporary.path, [root], { folder: [child] }, { stat });
  const prepared = await service.prepareBatch(1, request);
  const files = await collect(service, prepared);
  await expect(transfer(service, prepared.id, files[0]!)).rejects.toMatchObject({
    code: 'PreconditionFailed',
  });
  expect(read).not.toHaveBeenCalled();
  expect(await readFile(join(temporary.path, 'A', 'file.txt'), 'utf8')).toBe('external');
  service.finishBatch(1, prepared.id);
  await service.dispose();
});

it('refuses destination junction traversal', async (context) => {
  await using temporary = await mkdtempDisposable(join(tmpdir(), 'terra-plan-'));
  await mkdir(join(temporary.path, 'outside'));
  await mkdir(join(temporary.path, 'downloads'));
  try {
    await symlink(
      join(temporary.path, 'outside'),
      join(temporary.path, 'downloads', 'A'),
      'junction',
    );
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'EPERM') {
      context.skip('Junction creation is restricted.');
      return;
    }
    throw error;
  }
  const { service, request, list } = fixture(join(temporary.path, 'downloads'), [
    entry('a', 'A', 'directory'),
  ]);
  const prepared = await service.prepareBatch(1, request);
  service.confirmBatch(1, prepared.id);
  await expect(service.discoverBatchDirectory(1, prepared.id, 0, 0)).rejects.toMatchObject({
    code: 'InvalidDownloadName',
  });
  expect(list).not.toHaveBeenCalled();
  expect(await readdir(join(temporary.path, 'outside'))).toEqual([]);
  await service.dispose();
});

it('enforces session ownership and rejects stale plans after release', async () => {
  await using temporary = await mkdtempDisposable(join(tmpdir(), 'terra-plan-'));
  const { service, request } = fixture(temporary.path, [entry('one', 'one.txt')]);
  const prepared = await service.prepareBatch(1, request);
  await expect(service.resolveWork(2, { planId: prepared.id, itemId: 0 })).rejects.toMatchObject({
    code: 'InvalidArgument',
  });
  expect(() => service.finishBatch(2, prepared.id)).toThrow();
  await service.releaseBatch(2, prepared.id);
  await service.releaseBatch(1, prepared.id);
  await expect(service.resolveWork(1, { planId: prepared.id, itemId: 0 })).rejects.toMatchObject({
    code: 'InvalidArgument',
  });
  expect(await readdir(temporary.path)).toEqual([]);
  await service.dispose();
});

it.each(['standalone', 'grouped'] as const)(
  'retries %s work with a fresh execution while retaining its destination and identity',
  async (mode) => {
    await using temporary = await mkdtempDisposable(join(tmpdir(), 'terra-plan-'));
    const root = entry('one', 'one.txt');
    const { service, request, read } = fixture(temporary.path, [root]);
    const work =
      mode === 'standalone'
        ? await service.prepare(1, {
            ref: root.ref,
            expectedName: root.name,
            directory: temporary.path,
            replace: false,
          })
        : await service.prepareBatch(1, request).then((plan) => ({
            ref: { planId: plan.id, itemId: plan.items[0]!.id },
            path: plan.items[0]!.targetPath,
          }));
    read.mockRejectedValueOnce(new StorageError('NetworkError'));
    await expect(service.resolveWork(2, work.ref)).rejects.toMatchObject({
      code: 'InvalidArgument',
    });
    const first = await service.resolveWork(1, work.ref);
    await expect(service.run(1, first.id, () => {})).rejects.toMatchObject({
      code: 'NetworkError',
    });
    if (mode === 'grouped') service.finishBatch(1, work.ref.planId);
    const second = await service.resolveWork(1, work.ref);
    expect(second.id).not.toBe(first.id);
    expect(second.path).toBe(work.path);
    await service.run(1, second.id, () => {});
    expect(await readFile(work.path, 'utf8')).toBe('one');
    if (mode === 'grouped') {
      service.finishBatch(1, work.ref.planId);
      await service.releaseBatch(1, work.ref.planId);
    } else await service.releaseWork(1, work.ref);
    await expect(service.resolveWork(1, work.ref)).rejects.toMatchObject({
      code: 'InvalidArgument',
    });
    await service.dispose();
  },
);

it('cancels target resolution during metadata access and retains reservations until it settles', async () => {
  await using temporary = await mkdtempDisposable(join(tmpdir(), 'terra-plan-'));
  const root = entry('one', 'one.txt');
  let reads = 0;
  let started!: () => void;
  const resolving = new Promise<void>((resolve) => {
    started = resolve;
  });
  const stat: DownloadSource['stat'] = async (_ref, { signal }) => {
    if (++reads === 1) return root;
    started();
    await new Promise<void>((_resolve, reject) =>
      signal?.addEventListener('abort', () => reject(new StorageError('Cancelled')), {
        once: true,
      }),
    );
    return root;
  };
  const { service, request, read } = fixture(temporary.path, [root], {}, { stat });
  const group = await service.prepareBatch(1, request);
  const ref = { planId: group.id, itemId: 0 };
  const preparing = service.resolveWork(1, ref);
  const rejected = expect(preparing).rejects.toMatchObject({ code: 'Cancelled' });
  await resolving;
  expect(() => service.finishBatch(1, group.id)).toThrow(
    expect.objectContaining({ code: 'DownloadTargetBusy' }),
  );
  await service.cancelWork(1, ref);
  await rejected;
  expect(read).not.toHaveBeenCalled();
  expect(await readdir(temporary.path)).toEqual([]);
  service.finishBatch(1, group.id);
  await service.dispose();
});
