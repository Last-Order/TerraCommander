import { describe, expect, it, vi } from 'vitest';
import type { EntryRef } from '@shared/storage';
import { DirectoryEffectsStore } from './directory-effects';

const dirA: EntryRef = { connectionId: 'conn', spaceId: 'drive', locator: 'dir-a' };
const dirB: EntryRef = { connectionId: 'conn', spaceId: 'drive', locator: 'dir-b' };
const file1: EntryRef = { connectionId: 'conn', spaceId: 'drive', locator: 'file-1' };
const file2: EntryRef = { connectionId: 'conn', spaceId: 'drive', locator: 'file-2' };

describe('DirectoryEffectsStore', () => {
  it('notifies only listeners for entries whose busy state actually changed', () => {
    const store = new DirectoryEffectsStore();
    const onFile1 = vi.fn();
    const onFile2 = vi.fn();
    const onAnyBusy = vi.fn();

    const unsub1 = store.subscribeEntry(file1, onFile1);
    const unsub2 = store.subscribeEntry(file2, onFile2);
    const unsubBusy = store.subscribeBusy(onAnyBusy);

    store.apply({ busyEntries: [file1], renames: [] });
    expect(store.isBusy(file1)).toBe(true);
    expect(store.isBusy(file2)).toBe(false);
    expect(onFile1).toHaveBeenCalledTimes(1);
    expect(onFile2).not.toHaveBeenCalled();
    expect(onAnyBusy).toHaveBeenCalledTimes(1);

    // Re-applying the same busy set produces zero notifications.
    store.apply({ busyEntries: [{ ...file1 }], renames: [] });
    expect(onFile1).toHaveBeenCalledTimes(1);
    expect(onFile2).not.toHaveBeenCalled();
    expect(onAnyBusy).toHaveBeenCalledTimes(1);

    // Locking file2 does not notify file1.
    store.apply({ busyEntries: [file1, file2], renames: [] });
    expect(onFile1).toHaveBeenCalledTimes(1);
    expect(onFile2).toHaveBeenCalledTimes(1);
    expect(onAnyBusy).toHaveBeenCalledTimes(2);

    // Releasing file1 notifies only file1.
    store.apply({ busyEntries: [file2], renames: [] });
    expect(store.isBusy(file1)).toBe(false);
    expect(store.isBusy(file2)).toBe(true);
    expect(onFile1).toHaveBeenCalledTimes(2);
    expect(onFile2).toHaveBeenCalledTimes(1);
    expect(onAnyBusy).toHaveBeenCalledTimes(3);

    unsub1();
    unsub2();
    unsubBusy();
  });

  it('scopes optimistic rename notifications by parent directory and preserves map references', () => {
    const store = new DirectoryEffectsStore();
    const onDirA = vi.fn();
    const onDirB = vi.fn();

    store.subscribeDirectoryRenames(dirA, onDirA);
    store.subscribeDirectoryRenames(dirB, onDirB);

    const initialA = store.getDirectoryRenames(dirA);
    expect(initialA.size).toBe(0);

    // Busy-only changes never notify directory rename subscribers.
    store.apply({ busyEntries: [file1], renames: [] });
    expect(onDirA).not.toHaveBeenCalled();
    expect(onDirB).not.toHaveBeenCalled();
    expect(store.getDirectoryRenames(dirA)).toBe(initialA);

    // Rename in dirA notifies dirA only.
    store.apply({
      busyEntries: [file1],
      renames: [{ parent: dirA, entry: file1, name: 'renamed.txt' }],
    });
    expect(onDirA).toHaveBeenCalledTimes(1);
    expect(onDirB).not.toHaveBeenCalled();
    const renamesA = store.getDirectoryRenames(dirA);
    expect(renamesA.get('file-1')).toBe('renamed.txt');

    // Unrelated busy change preserves dirA's rename map reference.
    store.apply({
      busyEntries: [file1, file2],
      renames: [{ parent: dirA, entry: file1, name: 'renamed.txt' }],
    });
    expect(onDirA).toHaveBeenCalledTimes(1);
    expect(store.getDirectoryRenames(dirA)).toBe(renamesA);

    // Clearing the rename notifies dirA and returns to the empty map.
    store.apply({ busyEntries: [file2], renames: [] });
    expect(onDirA).toHaveBeenCalledTimes(2);
    expect(store.getDirectoryRenames(dirA).size).toBe(0);
    expect(store.getDirectoryRenames(dirA)).toBe(initialA);
  });
});
