import { createHash } from 'node:crypto';
import { mkdtempDisposable, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough, Readable } from 'node:stream';
import { expect, it, vi } from 'vitest';
import type { DownloadRequest } from '../../shared/downloads';
import type { Entry } from '../../shared/storage';
import { DownloadOutput } from './download-output';
import { DownloadService } from './download-service';
import type { DownloadSource } from './download-transfer';

async function fixture(directory: string, replace = false) {
  const content = Buffer.from('0123456789abcdef');
  const entry: Entry = {
    ref: { connectionId: 'account', spaceId: 'drive', locator: 'file' },
    name: 'file.bin',
    kind: 'file',
    size: content.length,
    checksums: [{ algorithm: 'sha256', value: createHash('sha256').update(content).digest('hex') }],
    capabilities: { read: { support: 'supported' }, rangeRead: { support: 'supported' } },
  };
  const streams: PassThrough[] = [];
  const dispose = vi.fn(async () => {});
  const read = vi.fn<DownloadSource['read']>(async (_ref, options) => {
    const stream = new PassThrough();
    streams.push(stream);
    return {
      stream,
      length: content.length - (options.range?.offset ?? 0),
      dispose: async () => {
        stream.destroy();
        await dispose();
      },
    };
  });
  const stat = vi.fn<DownloadSource['stat']>(async () => structuredClone(entry));
  const service = new DownloadService({ stat, read });
  const request: DownloadRequest = { ref: entry.ref, directory, expectedName: entry.name, replace };
  if (replace) await writeFile(join(directory, entry.name), 'original');
  const prepared = await prepareExecution(service, 1, request);
  const partialPath = async () => {
    if (!replace) return prepared.path;
    const temporary = (await readdir(directory)).find((name) =>
      name.startsWith('.terra-download-'),
    );
    if (!temporary) throw new Error('Missing partial output');
    return join(directory, temporary, 'content');
  };
  const start = async (attempt: string) => {
    const progress = vi.fn();
    const running = service.run(1, prepared.id, progress, attempt);
    await vi.waitFor(() =>
      expect(progress).toHaveBeenCalledWith(
        expect.objectContaining({ controls: { cancellable: true, pausable: true } }),
      ),
    );
    const stream = streams.at(-1);
    if (!stream) throw new Error('Missing read');
    return { running, stream, progress };
  };
  const writePrefix = async (stream: PassThrough, bytes: Buffer, expected: string) => {
    stream.write(bytes);
    await vi.waitFor(async () =>
      expect(await readFile(await partialPath(), 'utf8')).toBe(expected),
    );
  };
  return {
    service,
    request,
    prepared,
    content,
    entry,
    stat,
    read,
    dispose,
    start,
    partialPath,
    writePrefix,
  };
}

it('refuses paused resumption once cancellation begins', async () => {
  await using temporary = await mkdtempDisposable(join(tmpdir(), 'terra-resume-cancelling-'));
  const f = await fixture(temporary.path);
  try {
    const first = await f.start('first');
    await f.writePrefix(first.stream, f.content.subarray(0, 4), '0123');
    await f.service.pause(1, f.prepared.id);
    await first.running;
    const cancelling = f.service.cancel(1, f.prepared.id);
    expect(() => f.service.run(1, f.prepared.id, () => {}, 'second')).toThrow();
    await cancelling;
    expect(await readdir(temporary.path)).toEqual([]);
    const next = await prepareExecution(f.service, 2, f.request);
    await f.service.cancel(2, next.id);
  } finally {
    await f.service.dispose();
  }
});

it('refuses pause requests once active cancellation begins', async () => {
  await using temporary = await mkdtempDisposable(
    join(tmpdir(), 'terra-resume-exclusive-control-'),
  );
  const f = await fixture(temporary.path);
  try {
    const first = await f.start('first');
    const cancelled = expect(first.running).rejects.toMatchObject({ code: 'Cancelled' });
    const cancelling = f.service.cancel(1, f.prepared.id);
    await expect(f.service.pause(1, f.prepared.id)).rejects.toMatchObject({
      code: 'InvalidArgument',
    });
    await cancelling;
    await cancelled;
    expect(await readdir(temporary.path)).toEqual([]);
  } finally {
    await f.service.dispose();
  }
});

it.each(['cancel', 'dispose'] as const)(
  'waits for publication to settle during %s without requiring callers to inspect transfer phases',
  async (command) => {
    await using temporary = await mkdtempDisposable(join(tmpdir(), 'terra-resume-settlement-'));
    const f = await fixture(temporary.path, true);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const verification = vi
      .spyOn(DownloadOutput.prototype, 'verify')
      .mockImplementationOnce(async () => gate);
    try {
      const first = await f.start('first');
      first.stream.end(f.content);
      await vi.waitFor(() => expect(verification).toHaveBeenCalledOnce());
      const settled = vi.fn();
      const stopping = (
        command === 'cancel' ? f.service.cancel(1, f.prepared.id) : f.service.dispose()
      ).then(settled);
      if (command === 'cancel')
        await expect(f.service.prepare(2, f.request)).rejects.toMatchObject({
          code: 'DownloadTargetBusy',
        });
      await Promise.resolve();
      expect(settled).not.toHaveBeenCalled();
      release();
      await stopping;
      expect(await first.running).toEqual({ status: 'completed' });
      expect(await readFile(f.prepared.path)).toEqual(f.content);
    } finally {
      release();
      await f.service.dispose();
    }
  },
);

it.each([false, true])(
  'resumes multiple attempts at acknowledged offsets without releasing the destination; replace: %s',
  async (replace) => {
    await using temporary = await mkdtempDisposable(join(tmpdir(), 'terra-resume-'));
    const f = await fixture(temporary.path, replace);
    try {
      await expect(f.service.pause(1, f.prepared.id)).rejects.toMatchObject({
        code: 'InvalidArgument',
      });
      const first = await f.start('first');
      expect(() => f.service.pause(2, f.prepared.id)).toThrow();
      await f.writePrefix(first.stream, f.content.subarray(0, 4), '0123');
      await f.service.pause(1, f.prepared.id);
      expect(await first.running).toEqual({ status: 'paused', completedBytes: 4, totalBytes: 16 });
      expect(first.stream.destroyed).toBe(true);
      expect(f.dispose).toHaveBeenCalledOnce();
      await expect(f.service.prepare(2, f.request)).rejects.toMatchObject({
        code: 'DownloadTargetBusy',
      });
      if (replace) expect(await readFile(f.prepared.path, 'utf8')).toBe('original');

      const second = await f.start('second');
      expect(f.read.mock.lastCall?.[1]).toEqual({ range: { offset: 4 } });
      await f.writePrefix(second.stream, f.content.subarray(4, 9), '012345678');
      await f.service.pause(1, f.prepared.id);
      expect(await second.running).toMatchObject({ status: 'paused', completedBytes: 9 });

      const third = await f.start('third');
      expect(f.read.mock.lastCall?.[1]).toEqual({ range: { offset: 9 } });
      expect(third.progress.mock.calls[0]?.[0]).toMatchObject({
        completedBytes: 9,
        attempt: 'third',
        bytesPerSecond: 0,
      });
      third.stream.end(f.content.subarray(9));
      expect(await third.running).toEqual({ status: 'completed' });
      expect(await readFile(f.prepared.path)).toEqual(f.content);
      expect(await readdir(temporary.path)).toEqual(['file.bin']);
      const next = await prepareExecution(f.service, 2, { ...f.request, replace: true });
      await f.service.cancel(2, next.id);
    } finally {
      await f.service.dispose();
    }
  },
);

it.each([false, true])(
  'discards paused content on cancellation and session disposal; replace: %s',
  async (replace) => {
    await using temporary = await mkdtempDisposable(join(tmpdir(), 'terra-resume-cancel-'));
    for (const disposeOwner of [false, true]) {
      const f = await fixture(temporary.path, replace);
      try {
        const first = await f.start('first');
        await f.writePrefix(first.stream, f.content.subarray(0, 4), '0123');
        await f.service.pause(1, f.prepared.id);
        await first.running;
        if (disposeOwner) f.service.cancelOwner(1);
        else await f.service.cancel(1, f.prepared.id);
        await vi.waitFor(async () =>
          expect(await readdir(temporary.path)).toEqual(replace ? ['file.bin'] : []),
        );
        if (replace) expect(await readFile(f.prepared.path, 'utf8')).toBe('original');
      } finally {
        await f.service.dispose();
      }
    }
  },
);

it('rejects a changed source before requesting another range', async () => {
  await using temporary = await mkdtempDisposable(join(tmpdir(), 'terra-resume-source-'));
  const f = await fixture(temporary.path, true);
  try {
    const first = await f.start('first');
    await f.writePrefix(first.stream, f.content.subarray(0, 4), '0123');
    await f.service.pause(1, f.prepared.id);
    await first.running;
    f.stat.mockResolvedValue({
      ...f.entry,
      checksums: [{ algorithm: 'sha256', value: '0'.repeat(64) }],
    });
    await expect(f.service.run(1, f.prepared.id, () => {}, 'second')).rejects.toMatchObject({
      code: 'SourceChanged',
    });
    expect(f.read).toHaveBeenCalledOnce();
    expect(await readdir(temporary.path)).toEqual(['file.bin']);
    expect(await readFile(f.prepared.path, 'utf8')).toBe('original');
  } finally {
    await f.service.dispose();
  }
});

it.each(['modified', 'truncated', 'replaced'])(
  'preserves %s partial content and rejects unsafe resumption',
  async (change) => {
    await using temporary = await mkdtempDisposable(join(tmpdir(), 'terra-resume-output-'));
    const f = await fixture(temporary.path);
    try {
      const first = await f.start('first');
      await f.writePrefix(first.stream, f.content.subarray(0, 4), '0123');
      await f.service.pause(1, f.prepared.id);
      await first.running;
      if (change === 'replaced') await rename(f.prepared.path, join(temporary.path, 'moved'));
      const external = change === 'truncated' ? 'x' : 'edit';
      await writeFile(f.prepared.path, external);
      await expect(f.service.run(1, f.prepared.id, () => {}, 'second')).rejects.toMatchObject({
        code: 'PreconditionFailed',
      });
      expect(f.read).toHaveBeenCalledOnce();
      expect(await readFile(f.prepared.path, 'utf8')).toBe(external);
    } finally {
      await f.service.dispose();
    }
  },
);

it('verifies the full checksum before publishing a resumed replacement', async () => {
  await using temporary = await mkdtempDisposable(join(tmpdir(), 'terra-resume-integrity-'));
  const f = await fixture(temporary.path, true);
  try {
    const first = await f.start('first');
    await f.writePrefix(first.stream, f.content.subarray(0, 4), '0123');
    await f.service.pause(1, f.prepared.id);
    await first.running;
    f.read.mockResolvedValueOnce({
      stream: Readable.from([Buffer.from('x'.repeat(12))]),
      length: 12,
      dispose: async () => {},
    });
    await expect(f.service.run(1, f.prepared.id, () => {}, 'second')).rejects.toMatchObject({
      code: 'SourceChanged',
    });
    expect(await readFile(f.prepared.path, 'utf8')).toBe('original');
    expect(await readdir(temporary.path)).toEqual(['file.bin']);
  } finally {
    await f.service.dispose();
  }
});

it.each([0, 16])(
  'resumes a boundary checkpoint at byte %s without invalid or unnecessary ranges',
  async (bytes) => {
    await using temporary = await mkdtempDisposable(join(tmpdir(), 'terra-resume-boundary-'));
    const f = await fixture(temporary.path);
    try {
      const first = await f.start('first');
      if (bytes > 0) await f.writePrefix(first.stream, f.content, f.content.toString());
      await f.service.pause(1, f.prepared.id);
      expect(await first.running).toMatchObject({ status: 'paused', completedBytes: bytes });
      if (bytes === 0)
        f.read.mockResolvedValueOnce({
          stream: Readable.from([f.content]),
          length: f.content.length,
          dispose: async () => {},
        });
      expect(await f.service.run(1, f.prepared.id, () => {}, 'second')).toEqual({
        status: 'completed',
      });
      expect(f.read).toHaveBeenCalledTimes(bytes === 0 ? 2 : 1);
      if (bytes === 0) expect(f.read.mock.lastCall?.[1]).toEqual({});
      expect(await readFile(f.prepared.path)).toEqual(f.content);
    } finally {
      await f.service.dispose();
    }
  },
);

async function prepareExecution(
  service: DownloadService,
  owner: number,
  request: Parameters<DownloadService['prepare']>[1],
) {
  const work = await service.prepare(owner, request);
  return service.resolveWork(owner, work.ref);
}
