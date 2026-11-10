import type { EntryRef } from '../../shared/storage';
import type { StorageAccess } from '../storage';
import { StorageError } from '../storage/core/errors';

export async function measureDirectorySize(
  storage: Pick<StorageAccess, 'list'>,
  roots: readonly EntryRef[],
  signal: AbortSignal,
): Promise<number | null> {
  const directories = new Map(roots.map((ref) => [ref.locator, ref]));
  const visited = new Set(directories.keys());
  const pending = [...directories.values()];
  let bytes = 0;

  for (let parent = pending.pop(); parent; parent = pending.pop()) {
    const cursors = new Set<string>();
    let cursor: string | undefined;
    do {
      const page = await storage.list(parent, { cursor, pageSize: 1000 }, { signal });
      for (const { ref, kind, size } of page.entries) {
        if (visited.has(ref.locator)) continue;
        visited.add(ref.locator);
        if (kind === 'directory') {
          pending.push(ref);
        } else if (kind === 'file') {
          if (size === undefined || !Number.isSafeInteger(bytes + size)) return null;
          bytes += size;
        }
      }
      cursor = page.nextCursor;
      if (cursor !== undefined) {
        if (cursors.has(cursor)) throw new StorageError('OutcomeUnknown');
        cursors.add(cursor);
      }
    } while (cursor !== undefined);
  }

  return bytes;
}
