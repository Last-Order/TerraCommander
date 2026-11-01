import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { EntryRef } from '../../../shared/storage/models';
import type { StorageAccess } from '../access/storage-access';
import type { ReadHandle } from '../core/contracts';
import type { AdapterRegistry } from '../registry/adapter-registry';

export interface ReadableAdapterContractFixture {
  access: StorageAccess;
  registry: AdapterRegistry;
  root: EntryRef;
  children: EntryRef[];
  file: EntryRef;
  content: Uint8Array;
}

async function contents(handle: ReadHandle): Promise<Buffer> {
  const chunks: Uint8Array[] = [];
  try {
    for await (const chunk of handle.stream) chunks.push(chunk as Uint8Array);
    return Buffer.concat(chunks);
  } finally {
    await handle.dispose();
  }
}

/** Opt-in contract suite for adapters advertising ordinary and ranged byte reads. */
export function readableAdapterContract(
  name: string,
  setup: () => Promise<ReadableAdapterContractFixture>,
): void {
  describe(name, () => {
    let fixture: ReadableAdapterContractFixture;
    beforeEach(async () => {
      fixture = await setup();
    });
    afterEach(async () => {
      await fixture.registry.dispose();
    });

    it('lists all fixture children through bounded pages without collapsing names', async () => {
      const actual: EntryRef[] = [];
      let cursor: string | undefined;
      do {
        const page = await fixture.access.list(fixture.root, {
          pageSize: 1,
          ...(cursor ? { cursor } : {}),
        });
        actual.push(...page.entries.map((entry) => entry.ref));
        cursor = page.nextCursor;
        expect(actual.length).toBeLessThanOrEqual(fixture.children.length);
      } while (cursor);
      const key = (ref: EntryRef) => JSON.stringify([ref.connectionId, ref.spaceId, ref.locator]);
      expect(actual.map(key).sort()).toEqual(fixture.children.map(key).sort());
    });

    it('round-trips an entry reference through stat', async () => {
      expect((await fixture.access.stat(fixture.file)).ref).toEqual(fixture.file);
    });

    it('reads the exact fixture bytes and closes the handle', async () => {
      const handle = await fixture.access.read(fixture.file);
      expect(await contents(handle)).toEqual(Buffer.from(fixture.content));
      expect(handle.stream.destroyed).toBe(true);
    });

    it('maps offset and length to exact byte ranges', async () => {
      const offset = Math.min(1, fixture.content.length);
      const length = Math.min(2, fixture.content.length - offset);
      const handle = await fixture.access.read(fixture.file, { range: { offset, length } });
      expect(await contents(handle)).toEqual(
        Buffer.from(fixture.content.subarray(offset, offset + length)),
      );
    });
  });
}
