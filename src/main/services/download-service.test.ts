import { mkdtempDisposable, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough, Readable } from 'node:stream';
import { expect, it, vi } from 'vitest';
import type { DownloadRequest } from '../../shared/downloads';
import type { Entry } from '../../shared/storage';
import type { ReadHandle } from '../storage/core/contracts';
import { StorageError } from '../storage/core/errors';
import { DownloadService } from './download-service';

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
    const prepared = await service.prepare(1, { ...request, replace });
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
  const prepared = await service.prepare(1, request);
  await writeFile(path, 'external');
  await expect(service.run(1, prepared.id, () => {})).rejects.toMatchObject({
    code: 'AlreadyExists',
  });
  expect(await readFile(path, 'utf8')).toBe('external');
  expect(await readdir(temporary.path)).toEqual([entry.name]);
  expect(read).not.toHaveBeenCalled();
  await service.dispose();
});

it.each(['network', 'length'])(
  'removes an incomplete new file after %s failure',
  async (failure) => {
    await using temporary = await mkdtempDisposable(join(tmpdir(), 'terra-download-'));
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
    const prepared = await service.prepare(1, request);
    await expect(service.run(1, prepared.id, () => {})).rejects.toMatchObject({
      code: failure === 'network' ? 'NetworkError' : 'OutcomeUnknown',
    });
    expect(await readdir(temporary.path)).toEqual([]);
    expect(dispose).toHaveBeenCalledOnce();
    await service.dispose();
  },
);

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
    const prepared = await service.prepare(1, request);
    await expect(service.run(1, prepared.id, () => {})).rejects.toMatchObject({
      code: outcome === 'failed' ? 'NetworkError' : 'PreconditionFailed',
    });
    expect(await readFile(path, 'utf8')).toBe('external');
    await service.dispose();
  },
);

it.each(['network', 'length'])('preserves an existing file on %s failure', async (failure) => {
  await using temporary = await mkdtempDisposable(join(tmpdir(), 'terra-download-'));
  const path = join(temporary.path, entry.name);
  await writeFile(path, 'old');
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
  const prepared = await service.prepare(1, { ...request, replace: true });
  await expect(service.run(1, prepared.id, () => {})).rejects.toMatchObject({
    code: failure === 'network' ? 'NetworkError' : 'OutcomeUnknown',
  });
  expect(await readFile(path, 'utf8')).toBe('old');
  expect(await readdir(temporary.path)).toEqual([entry.name]);
  expect(dispose).toHaveBeenCalledOnce();
  await service.dispose();
});

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
    const prepared = await service.prepare(1, downloadRequest);
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
    const next = await service.prepare(2, downloadRequest);
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
  const prepared = await service.prepare(1, request);
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
  const prepared = await service.prepare(1, request);
  expect(prepared.path).toBe(join(temporary.path, sourceEntry.name));
  await service.cancel(1, prepared.id);
  expect(read).not.toHaveBeenCalled();
  await service.dispose();
});
