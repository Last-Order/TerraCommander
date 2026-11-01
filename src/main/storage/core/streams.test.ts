import { Readable } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import type { ByteSource } from './contracts';
import {
  byteSource,
  connectFixture,
  fixtureRef,
  readHandle,
  TestCheckpointStore,
} from '../testing/fixtures';
import { deferred } from '../testing/deferred';
import { StorageAccess } from '../access/storage-access';
import { managedRead, scopeSource } from './streams';

describe('stream lifecycle', () => {
  it('releases malformed source handles instead of leaking their resources', async () => {
    const disposed = vi.fn();
    const scoped = scopeSource(
      {
        kind: 'one-shot',
        async open() {
          return { ...readHandle(Buffer.from('a'), disposed), length: Number.NaN };
        },
      },
      {},
    );
    await expect(scoped.source.open(undefined, {})).rejects.toMatchObject({
      code: 'OutcomeUnknown',
    });
    expect(disposed).toHaveBeenCalledTimes(1);
    await scoped.dispose();
  });
  it('propagates backpressure and disposes on early consumption exit', async () => {
    let produced = 0;
    let released = 0;
    let disposed = 0;
    const raw = Readable.from(
      (async function* () {
        for (let index = 0; index < 10000; index += 1) {
          produced += 1;
          yield Buffer.alloc(65536);
        }
      })(),
      { objectMode: false, highWaterMark: 65536 },
    );
    const handle = managedRead(
      {
        stream: raw,
        async dispose() {
          disposed += 1;
          raw.destroy();
        },
      },
      {},
      () => {
        released += 1;
      },
    );
    for await (const chunk of handle.stream) {
      expect(chunk.byteLength).toBeGreaterThan(0);
      break;
    }
    await handle.dispose();
    expect(produced).toBeLessThan(100);
    expect(disposed).toBe(1);
    expect(released).toBe(1);
  });

  it('finishes naturally without premature-close errors and verifies content length', async () => {
    const disposal = vi.fn();
    const handle = managedRead(readHandle(Buffer.from('abcdef'), disposal), {});
    const chunks: Uint8Array[] = [];
    for await (const chunk of handle.stream) chunks.push(chunk as Uint8Array);
    await handle.dispose();
    expect(Buffer.concat(chunks).toString()).toBe('abcdef');
    expect(disposal).toHaveBeenCalledTimes(1);
    const truncated = managedRead({ ...readHandle(Buffer.from('abc')), length: 5 }, {});
    await expect(
      (async () => {
        for await (const _chunk of truncated.stream) {
          /* Consume. */
        }
      })(),
    ).rejects.toMatchObject({ code: 'OutcomeUnknown' });
  });

  it('cancels an idle read after the facade returns and drains its connection lease', async () => {
    const { adapter, registry } = await connectFixture();
    const access = new StorageAccess(registry, new TestCheckpointStore());
    const handle = await access.read(fixtureRef());
    await registry.disconnect('connection');
    expect(handle.stream.destroyed).toBe(true);
    expect(adapter.streamDisposals).toBe(1);
    expect(adapter.disposed).toBe(1);
    await handle.dispose();
    expect(adapter.streamDisposals).toBe(1);
  });

  it('keeps caller cancellation active throughout consumption and redacts stream errors', async () => {
    const controller = new AbortController();
    const handle = managedRead(readHandle(Buffer.from('test')), { signal: controller.signal });
    controller.abort();
    await expect(
      (async () => {
        for await (const _chunk of handle.stream) {
        }
      })(),
    ).rejects.toMatchObject({ code: 'Cancelled' });
    const broken = new Readable({
      read() {
        this.destroy(new Error('secret signed URL'));
      },
    });
    const wrapped = managedRead(
      {
        stream: broken,
        async dispose() {
          broken.destroy();
        },
      },
      {},
    );
    const failure = await (async () => {
      for await (const _chunk of wrapped.stream) {
      }
    })().catch((error: unknown) => error);
    expect(JSON.stringify(failure)).not.toContain('secret');
    expect(failure).toMatchObject({ code: 'OutcomeUnknown' });
  });

  it('guards one-shot sources and closes handles opened during disposal', async () => {
    const single: ByteSource = {
      kind: 'one-shot',
      async open() {
        return readHandle(Buffer.from('a'));
      },
    };
    const scoped = scopeSource(single, {});
    const first = await scoped.source.open(undefined, {});
    await expect(scoped.source.open(undefined, {})).rejects.toMatchObject({ code: 'Unsupported' });
    await first.dispose();
    await scoped.dispose();

    const gate = deferred<void>();
    const dispose = vi.fn();
    const late = scopeSource(
      {
        kind: 'one-shot',
        async open() {
          await gate.promise;
          return readHandle(Buffer.from('a'), dispose);
        },
      },
      {},
    );
    const opening = late.source.open(undefined, {});
    const rejection = expect(opening).rejects.toMatchObject({ code: 'Cancelled' });
    await late.dispose();
    gate.resolve();
    await rejection;
    expect(dispose).toHaveBeenCalledTimes(1);
  });

  it('validates source ranges and honors cancellation before opening', async () => {
    const fixture = byteSource();
    const scoped = scopeSource(fixture.source, {});
    await expect(scoped.source.open({ offset: 5, length: 2 }, {})).rejects.toMatchObject({
      code: 'InvalidArgument',
    });
    await expect(
      scoped.source.open(undefined, { signal: AbortSignal.abort() }),
    ).rejects.toMatchObject({ code: 'Cancelled' });
    expect(fixture.opened).toEqual([]);
    await scoped.dispose();
  });
});
