import { expect, it, vi } from 'vitest';
import type { Entry, EntryRef } from '../../shared/storage';
import type { StorageAccess } from '../storage';
import { measureDirectorySize } from './measure-directory-size';

function ref(locator: string): EntryRef {
  return { connectionId: 'drive', spaceId: 'my-drive', locator };
}

function entry(locator: string, kind: Entry['kind'], size?: number): Entry {
  return { ref: ref(locator), name: locator, kind, size, capabilities: {} };
}

it('adds file sizes across selected folders and pages without following links or counting duplicates', async () => {
  const list = vi.fn<StorageAccess['list']>(async ({ locator }, request) => {
    if (locator === 'empty') return { entries: [] };
    if (locator === 'nested') return { entries: [entry('nested-file', 'file', 7)] };
    if (locator !== 'folder') throw new Error(`Unexpected listing of ${locator}`);
    if (request?.cursor === 'second') return { entries: [], nextCursor: 'last' };
    const file = entry('file', 'file', 11);
    return request?.cursor === 'last'
      ? { entries: [file, entry('last-file', 'file', 13)] }
      : {
          entries: [file, entry('nested', 'directory'), entry('link', 'link')],
          nextCursor: 'second',
        };
  });
  const { signal } = new AbortController();
  expect(await measureDirectorySize({ list }, [ref('folder'), ref('empty')], signal)).toBe(31);
  expect(list).toHaveBeenCalledWith(ref('folder'), { cursor: 'last', pageSize: 1000 }, { signal });
});

it('does not report a total when file sizes are unknown or a cursor repeats', async () => {
  const list = vi
    .fn<StorageAccess['list']>()
    .mockResolvedValue({ entries: [entry('file', 'file')] });
  const { signal } = new AbortController();
  expect(await measureDirectorySize({ list }, [ref('folder')], signal)).toBeNull();

  list.mockResolvedValue({ entries: [], nextCursor: 'repeat' });
  await expect(measureDirectorySize({ list }, [ref('folder')], signal)).rejects.toMatchObject({
    code: 'OutcomeUnknown',
  });
});
