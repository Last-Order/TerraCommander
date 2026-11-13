import { describe, expect, it, vi } from 'vitest';
import type { ByteRange } from '../../../shared/storage/models';
import { StorageError } from '../core/errors';
import {
  byteSource,
  connectFixture,
  createTarget,
  fixtureEntry,
  FixtureAdapter,
  fixtureRef,
  TestCheckpointStore,
} from '../testing/fixtures';
import { StorageAccess } from './storage-access';

async function setup() {
  const fixture = await connectFixture();
  return { ...fixture, access: new StorageAccess(fixture.registry, new TestCheckpointStore()) };
}

describe('storage access dispatch and native references', () => {
  it('forwards byte ranges and releases handles when adapters exceed them', async () => {
    const { adapter, registry, access } = await setup();
    const handle = await access.read(fixtureRef(), { range: { offset: 1, length: 2 } });
    const chunks: Uint8Array[] = [];
    for await (const chunk of handle.stream) chunks.push(chunk as Uint8Array);
    expect(Buffer.concat(chunks).toString()).toBe('bc');
    await handle.dispose();
    const original = adapter.read.bind(adapter);
    adapter.read = (ref, _options, ctx) => original(ref, {}, ctx);
    await expect(
      access.read(fixtureRef(), { range: { offset: 1, length: 2 } }),
    ).rejects.toMatchObject({ code: 'OutcomeUnknown' });
    expect(adapter.streamDisposals).toBe(2);
    await registry.dispose();
  });
  it('preserves duplicate names, exact keys and absent metadata', async () => {
    const { adapter, registry, access } = await setup();
    const locators = ['opaque-id-1', 'opaque-id-2', 'a//.././b', 'a/', 'A', 'a'];
    adapter.entries = locators.map((locator) =>
      fixtureEntry(
        fixtureRef('connection', locator),
        'same name',
        locator === 'a/' ? 'directory' : 'file',
      ),
    );
    const page = await access.list(fixtureRef());
    expect(page.entries.map((entry) => entry.ref.locator)).toEqual(locators);
    expect(page.entries.every((entry) => entry.name === 'same name')).toBe(true);
    expect(page.entries[0]).not.toHaveProperty('size');
    expect(page.entries.find((entry) => entry.ref.locator === 'a/')?.kind).toBe('directory');
    for (const entry of page.entries) expect((await access.stat(entry.ref)).ref).toEqual(entry.ref);
    await registry.dispose();
  });

  it('isolates connections and validates returned ownership', async () => {
    const { adapter, registry, access } = await setup();
    const other = new FixtureAdapter('other');
    registry.register({
      provider: 'other-provider',
      async create() {
        return other;
      },
    });
    await registry.connect({ id: 'other', provider: 'other-provider', configuration: {} });
    await access.stat(fixtureRef('other'));
    expect(adapter.calls).toEqual([]);
    adapter.stat = vi.fn().mockResolvedValue(fixtureEntry(fixtureRef('other')));
    await expect(access.stat(fixtureRef())).rejects.toMatchObject({ code: 'OutcomeUnknown' });
    await registry.disconnect('other');
    await expect(access.stat(fixtureRef('other'))).rejects.toMatchObject({ code: 'NotFound' });
    await registry.dispose();
  });

  it('binds opaque cursors to the connection, parent and page size', async () => {
    const { adapter, registry, access } = await setup();
    adapter.entries = ['a', 'b', 'c'].map((locator) =>
      fixtureEntry(fixtureRef('connection', locator)),
    );
    const first = await access.list(fixtureRef(), { pageSize: 1 });
    const cursor = first.nextCursor!;
    expect(cursor).not.toBe('1');
    expect((await access.list(fixtureRef(), { pageSize: 1, cursor })).entries[0]?.ref.locator).toBe(
      'b',
    );
    for (const request of [
      access.list(fixtureRef(), { pageSize: 2, cursor }),
      access.list(fixtureRef('connection', 'other-parent'), { pageSize: 1, cursor }),
      access.list(fixtureRef(), { pageSize: 1, cursor: `${cursor}tampered` }),
    ])
      await expect(request).rejects.toMatchObject({ code: 'InvalidArgument' });
    await registry.dispose();
  });

  it('keeps continuation tokens from empty intermediate pages', async () => {
    const { adapter, registry, access } = await setup();
    adapter.list = vi
      .fn()
      .mockResolvedValueOnce({ entries: [], nextCursor: 'continue' })
      .mockResolvedValueOnce({ entries: [] });
    const page = await access.list(fixtureRef());
    expect(page.entries).toEqual([]);
    expect(page.nextCursor).toBeTruthy();
    expect(await access.list(fixtureRef(), { cursor: page.nextCursor })).toEqual({ entries: [] });
    await registry.dispose();
  });

  it('blocks unsupported mutations without emulation and permits unknown ordinary reads', async () => {
    const { adapter, registry, access } = await setup();
    adapter.caps.copyWithin = { support: 'unsupported' };
    adapter.caps.moveWithin = { support: 'unsupported' };
    adapter.caps.remove = { support: 'unsupported' };
    await expect(access.remove(fixtureRef())).rejects.toMatchObject({ code: 'Unsupported' });
    await expect(
      access.copyWithin(fixtureRef(), { parent: fixtureRef(), name: 'copy' }),
    ).rejects.toMatchObject({ code: 'Unsupported' });
    await expect(
      access.moveWithin(fixtureRef(), { parent: fixtureRef(), name: 'move' }),
    ).rejects.toMatchObject({ code: 'Unsupported' });
    await expect(
      access.copyWithin(fixtureRef(), { parent: fixtureRef('other'), name: 'copy' }),
    ).rejects.toMatchObject({ code: 'Unsupported' });
    expect(adapter.calls).toEqual([]);
    adapter.caps.read = { support: 'unknown' };
    const handle = await access.read(fixtureRef());
    await handle.dispose();
    await registry.dispose();
  });

  it.each<ByteRange>([
    { offset: -1 },
    { offset: 0.5 },
    { offset: Number.MAX_SAFE_INTEGER, length: 1 },
  ])('rejects invalid byte ranges %j before dispatch', async (range) => {
    const { adapter, registry, access } = await setup();
    await expect(access.read(fixtureRef(), { range })).rejects.toMatchObject({
      code: 'InvalidArgument',
    });
    expect(adapter.calls).toEqual([]);
    await registry.dispose();
  });

  it('requires positive support for ranges and conditional guarantees', async () => {
    const { adapter, registry, access } = await setup();
    adapter.caps.rangeRead = { support: 'unknown' };
    adapter.caps.conditionalWrite = { support: 'unsupported' };
    await expect(access.read(fixtureRef(), { range: { offset: 1 } })).rejects.toMatchObject({
      code: 'Unsupported',
    });
    await expect(
      access.write(
        {
          kind: 'replace',
          ref: fixtureRef(),
          policy: 'replace-if-version',
          expectedRevision: 'version',
        },
        byteSource().source,
      ),
    ).rejects.toMatchObject({ code: 'Unsupported' });
    expect(adapter.calls).toEqual([]);
    await registry.dispose();
  });

  it('writes through a managed byte source, creates folders and returns changed move references', async () => {
    const { adapter, registry, access } = await setup();
    const source = byteSource();
    await access.write(createTarget(), source.source);
    expect(adapter.lastWrite?.toString()).toBe('abcdef');
    expect(source.disposals).toBe(1);
    expect((await access.createDirectory({ parent: fixtureRef(), name: 'new' })).kind).toBe(
      'directory',
    );
    expect(
      (
        await access.moveWithin(fixtureRef('connection', 'old'), {
          parent: fixtureRef(),
          name: 'new',
        })
      ).ref.locator,
    ).toBe('new');
    await access.remove(fixtureRef('connection', 'new'));
    expect(adapter.calls).toContain('remove');
    await registry.dispose();
  });

  it('redacts raw adapter failures and cancellation never reaches an adapter', async () => {
    const { adapter, registry, access } = await setup();
    const stat = vi.fn().mockRejectedValue(new Error('https://secret.invalid/token'));
    adapter.stat = stat;
    const error = await access.stat(fixtureRef()).catch((value: unknown) => value);
    expect(error).toBeInstanceOf(StorageError);
    expect(JSON.stringify(error)).not.toContain('secret');
    expect((error as StorageError).code).toBe('OutcomeUnknown');
    const aborted = AbortSignal.abort();
    await expect(access.stat(fixtureRef(), { signal: aborted })).rejects.toMatchObject({
      code: 'Cancelled',
    });
    expect(stat).toHaveBeenCalledTimes(1);
    await registry.dispose();
  });
});
