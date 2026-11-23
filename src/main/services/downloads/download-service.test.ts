import {
  mkdtempDisposable,
  readFile,
  readdir,
  realpath,
  rename,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough, Readable } from 'node:stream';
import { expect, it, vi } from 'vitest';
import type { ReadHandle } from '@main/storage/core/contracts';
import { StorageError } from '@main/storage/core/errors';
import type { Entry } from '@shared/storage';
import { DownloadService } from './download-service';
import type { DownloadRequest } from './download-types';

const entry: Entry = {
  ref: { connectionId: 'account', spaceId: 'my-drive', locator: 'file' },
  name: 'file.txt',
  kind: 'file',
  capabilities: { read: { support: 'supported' } },
};
function fixture(
  directory: string,
  read: () => Promise<ReadHandle> = async () => ({
    stream: Readable.from([Buffer.from('content')]),
    length: 7,
    dispose: async () => {},
  }),
  sourceEntry: Entry = entry,
) {
  const service = new DownloadService({ stat: async () => sourceEntry, read });
  const request: DownloadRequest = {
    ref: entry.ref,
    directory,
    expectedName: sourceEntry.name,
    replace: false,
  };
  return { service, request };
}

it.each([false, true])(
  'publishes complete bytes and releases the target; replace: %s',
  async (replace) => {
    await using temporary = await mkdtempDisposable(join(tmpdir(), 'terra-download-'));
    const path = join(temporary.path, entry.name);
    if (replace) await writeFile(path, 'old');
    const { service, request } = fixture(temporary.path, async () => {
      expect(await readFile(path, 'utf8')).toBe(replace ? 'old' : '');
      if (!replace) expect(await readdir(temporary.path)).toEqual([entry.name]);
      return {
        stream: Readable.from([Buffer.from('content')]),
        length: 7,
        dispose: async () => {},
      };
    });
    const prepared = await prepareExecution(service, 1, { ...request, replace });
    const progress = vi.fn();
    await service.run(1, prepared.id, progress);
    expect(await readFile(path, 'utf8')).toBe('content');
    expect(await readdir(temporary.path)).toEqual([entry.name]);
    expect(progress).toHaveBeenLastCalledWith({
      id: prepared.id,
      attempt: expect.any(String),
      controls: { cancellable: false, pausable: false },
      stage: 'saving',
      completedBytes: 7,
      totalBytes: 7,
    });
    await expect(service.prepare(1, request)).rejects.toMatchObject({ code: 'AlreadyExists' });
    await service.dispose();
  },
);

it('rejects a file created after preparation before opening the source', async () => {
  await using temporary = await mkdtempDisposable(join(tmpdir(), 'terra-download-'));
  const path = join(temporary.path, entry.name);
  const read = vi.fn();
  const { service, request } = fixture(temporary.path, read);
  const prepared = await prepareExecution(service, 1, request);
  await writeFile(path, 'external');
  await expect(service.run(1, prepared.id, () => {})).rejects.toMatchObject({
    code: 'AlreadyExists',
  });
  expect(await readFile(path, 'utf8')).toBe('external');
  expect(await readdir(temporary.path)).toEqual([entry.name]);
  expect(read).not.toHaveBeenCalled();
  await service.dispose();
});

it.each([
  { failure: 'network', replace: false },
  { failure: 'length', replace: false },
  { failure: 'network', replace: true },
  { failure: 'length', replace: true },
])('cleans up after $failure failure with replace=$replace', async ({ failure, replace }) => {
  await using temporary = await mkdtempDisposable(join(tmpdir(), 'terra-download-'));
  const path = join(temporary.path, entry.name);
  if (replace) await writeFile(path, 'old');
  const dispose = vi.fn(async () => {});
  const { service, request } = fixture(temporary.path, async () => ({
    stream: Readable.from(
      (async function* () {
        yield Buffer.from('partial');
        if (failure === 'network') throw new StorageError('NetworkError');
      })(),
    ),
    length: 100,
    dispose,
  }));
  const prepared = await prepareExecution(service, 1, { ...request, replace });
  await expect(service.run(1, prepared.id, () => {})).rejects.toMatchObject({
    code: failure === 'network' ? 'NetworkError' : 'OutcomeUnknown',
  });
  expect(await readdir(temporary.path)).toEqual(replace ? [entry.name] : []);
  if (replace) expect(await readFile(path, 'utf8')).toBe('old');
  expect(dispose).toHaveBeenCalledOnce();
  await service.dispose();
});

it.each(['failed', 'completed'])(
  'preserves an external replacement and rejects the %s download',
  async (outcome) => {
    await using temporary = await mkdtempDisposable(join(tmpdir(), 'terra-download-'));
    const path = join(temporary.path, entry.name);
    const { service, request } = fixture(temporary.path, async () => {
      await rename(path, join(temporary.path, 'moved.txt'));
      await writeFile(path, 'external');
      if (outcome === 'failed') throw new StorageError('NetworkError');
      return {
        stream: Readable.from([Buffer.from('content')]),
        length: 7,
        dispose: async () => {},
      };
    });
    const prepared = await prepareExecution(service, 1, request);
    await expect(service.run(1, prepared.id, () => {})).rejects.toMatchObject({
      code: outcome === 'failed' ? 'NetworkError' : 'PreconditionFailed',
    });
    expect(await readFile(path, 'utf8')).toBe('external');
    await service.dispose();
  },
);

it.each([false, true])(
  'cancels active reads, cleans owned output, and releases the target; replace: %s',
  async (replace) => {
    await using temporary = await mkdtempDisposable(join(tmpdir(), 'terra-download-'));
    const path = join(temporary.path, entry.name);
    if (replace) await writeFile(path, 'old');
    const stream = new PassThrough();
    const dispose = vi.fn(async () => {
      stream.destroy();
    });
    const { service, request } = fixture(temporary.path, async () => ({ stream, dispose }));
    const downloadRequest = { ...request, replace };
    const prepared = await prepareExecution(service, 1, downloadRequest);
    await expect(service.prepare(2, downloadRequest)).rejects.toMatchObject({
      code: 'DownloadTargetBusy',
    });
    expect(() => service.run(2, prepared.id, () => {})).toThrow();
    await service.cancel(2, prepared.id);
    const progress = vi.fn();
    const running = service.run(1, prepared.id, progress);
    const rejected = expect(running).rejects.toMatchObject({ code: 'Cancelled' });
    await vi.waitFor(() => expect(progress).toHaveBeenCalled());
    await service.cancel(1, prepared.id);
    await rejected;
    expect(dispose).toHaveBeenCalledOnce();
    expect(await readdir(temporary.path)).toEqual(replace ? [entry.name] : []);
    if (replace) expect(await readFile(path, 'utf8')).toBe('old');
    const next = await prepareExecution(service, 2, downloadRequest);
    await service.cancel(2, next.id);
    await service.dispose();
  },
);

it.each([
  { length: 0, content: '' },
  { length: undefined, content: 'unknown length' },
])('downloads complete content with length $length', async ({ length, content }) => {
  await using temporary = await mkdtempDisposable(join(tmpdir(), 'terra-download-'));
  const { service, request } = fixture(temporary.path, async () => ({
    stream: Readable.from([Buffer.from(content)]),
    ...(length !== undefined ? { length } : {}),
    dispose: async () => {},
  }));
  const prepared = await prepareExecution(service, 1, request);
  await service.run(1, prepared.id, () => {});
  expect(await readFile(prepared.path, 'utf8')).toBe(content);
  await service.dispose();
});

it('rejects invalid directories and names before opening a stream', async () => {
  await using temporary = await mkdtempDisposable(join(tmpdir(), 'terra-download-'));
  const read = vi.fn();
  const { service, request } = fixture(temporary.path, read);
  for (const directory of ['', 'relative', join(temporary.path, 'missing')])
    await expect(service.prepare(1, { ...request, directory })).rejects.toMatchObject({
      code: 'InvalidDownloadDirectory',
    });
  for (const name of ['../outside', '..', '']) {
    const invalid = fixture(temporary.path, read, { ...entry, name });
    await expect(invalid.service.prepare(1, invalid.request)).rejects.toMatchObject({
      code: 'InvalidDownloadName',
    });
    await invalid.service.dispose();
  }
  expect(read).not.toHaveBeenCalled();
  await service.dispose();
});

it('uses the provider name and refuses a different name even when replacement is requested', async () => {
  await using temporary = await mkdtempDisposable(join(tmpdir(), 'terra-download-'));
  const read = vi.fn();
  const sourceEntry = { ...entry, name: '原文件 [4K].m2ts' };
  const { service, request } = fixture(temporary.path, read, sourceEntry);
  const other = join(temporary.path, 'other.txt');
  await writeFile(other, 'preserved');
  await expect(
    service.prepare(1, { ...request, expectedName: 'other.txt', replace: true }),
  ).rejects.toMatchObject({ code: 'PreconditionFailed' });
  expect(await readFile(other, 'utf8')).toBe('preserved');
  const prepared = await prepareExecution(service, 1, request);
  expect(prepared.path).toBe(join(await realpath(temporary.path), sourceEntry.name));
  await service.cancel(1, prepared.id);
  expect(read).not.toHaveBeenCalled();
  await service.dispose();
});

it('skips pre-enqueue remote stat when a known entry snapshot is supplied and verifies on resolve', async () => {
  await using temporary = await mkdtempDisposable(join(tmpdir(), 'terra-download-defer-'));
  const read = vi.fn();
  const stat = vi.fn(async () => entry);
  const service = new DownloadService({ stat, read });

  const work = await service.prepare(1, {
    ref: entry.ref,
    directory: temporary.path,
    expectedName: entry.name,
    replace: false,
    entry,
  });
  expect(stat).not.toHaveBeenCalled();

  const execution = await service.resolveWork(1, work.ref);
  expect(stat).toHaveBeenCalledTimes(1);
  await service.cancel(1, execution.id);

  await writeFile(join(temporary.path, entry.name), 'existing');
  const batch = await service.prepareBatch(1, {
    entries: [{ ref: entry.ref, expectedName: entry.name, entry }],
    directory: temporary.path,
  });
  expect(stat).toHaveBeenCalledTimes(1);
  expect(batch.conflicts).toEqual([entry.name]);
  await service.dispose();
});

async function prepareExecution(
  service: DownloadService,
  owner: number,
  request: Parameters<DownloadService['prepare']>[1],
) {
  const work = await service.prepare(owner, request);
  return service.resolveWork(owner, work.ref);
}
