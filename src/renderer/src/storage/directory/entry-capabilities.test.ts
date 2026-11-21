import { describe, expect, it } from 'vitest';
import type { Capabilities, Entry } from '@shared/storage';
import { localConnectionId } from '@shared/storage-browser';
import type { PendingEntryEffect } from '../tasks/pending-entry-effects';
import { canDeleteEntry, resolveEntryCapabilities } from './entry-capabilities';

function makeEntry(
  kind: Entry['kind'],
  locator: string,
  options: { connectionId?: string; capabilities?: Capabilities } = {},
): Entry {
  return {
    kind,
    ref: {
      connectionId: options.connectionId ?? 'drive-1',
      spaceId: 'space-1',
      locator,
    },
    name: locator,
    capabilities: options.capabilities ?? {},
  };
}

function entryMap(...items: Entry[]): Map<string, Entry> {
  return new Map(items.map((item) => [item.ref.locator, item]));
}

describe('canDeleteEntry', () => {
  it('allows files, directories, and links unless remove is unsupported', () => {
    expect(canDeleteEntry(makeEntry('file', 'a'))).toBe(true);
    expect(canDeleteEntry(makeEntry('directory', 'b'))).toBe(true);
    expect(canDeleteEntry(makeEntry('link', 'c'))).toBe(true);
    expect(
      canDeleteEntry(
        makeEntry('file', 'd', { capabilities: { remove: { support: 'unsupported' } } }),
      ),
    ).toBe(false);
    expect(canDeleteEntry(undefined)).toBe(false);
  });
});

describe('resolveEntryCapabilities', () => {
  it('disables all actions when nothing is selected or locators are missing', () => {
    const entries = entryMap(makeEntry('file', 'a'));
    const result = resolveEntryCapabilities(entries, new Set(['missing']), new Map());

    expect(result).toEqual({
      selectedEntries: [],
      renamableEntry: undefined,
      canCopy: false,
      canCut: false,
      canDownload: false,
      canRename: false,
      canDelete: false,
      renamePending: false,
      selectionBusy: false,
    });
  });

  it('enables download for remote files/directories but not local entries', () => {
    const remoteFile = makeEntry('file', 'remote-file');
    const localFile = makeEntry('file', 'local-file', { connectionId: localConnectionId });
    const entries = entryMap(remoteFile, localFile);

    expect(resolveEntryCapabilities(entries, new Set(['remote-file']), new Map()).canDownload).toBe(
      true,
    );
    expect(resolveEntryCapabilities(entries, new Set(['local-file']), new Map()).canDownload).toBe(
      false,
    );
    expect(
      resolveEntryCapabilities(entries, new Set(['remote-file', 'local-file']), new Map())
        .canDownload,
    ).toBe(false);
  });

  it('only enables rename for a single renamable entry and tracks busy state', () => {
    const fileA = makeEntry('file', 'a');
    const fileB = makeEntry('file', 'b');
    const entries = entryMap(fileA, fileB);
    const pending = new Map<string, PendingEntryEffect>([['a', { busy: true }]]);

    const single = resolveEntryCapabilities(entries, new Set(['a']), pending);
    expect(single.canRename).toBe(true);
    expect(single.renamableEntry).toBe(fileA);
    expect(single.renamePending).toBe(true);
    expect(single.selectionBusy).toBe(true);

    const multiple = resolveEntryCapabilities(entries, new Set(['a', 'b']), pending);
    expect(multiple.canRename).toBe(false);
    expect(multiple.renamableEntry).toBeUndefined();
    expect(multiple.renamePending).toBe(false);
    expect(multiple.selectionBusy).toBe(true);
  });

  it('allows cutting when either moveWithin or remove is supported, and blocks copying links', () => {
    const link = makeEntry('link', 'shortcut', {
      capabilities: {
        moveWithin: { support: 'unsupported' },
        remove: { support: 'supported' },
      },
    });
    const pinned = makeEntry('file', 'pinned', {
      capabilities: {
        moveWithin: { support: 'unsupported' },
        remove: { support: 'unsupported' },
      },
    });
    const entries = entryMap(link, pinned);

    const linkResult = resolveEntryCapabilities(entries, new Set(['shortcut']), new Map());
    expect(linkResult.canCopy).toBe(false);
    expect(linkResult.canCut).toBe(true);
    expect(linkResult.canDownload).toBe(false);

    const pinnedResult = resolveEntryCapabilities(entries, new Set(['pinned']), new Map());
    expect(pinnedResult.canCut).toBe(false);
    expect(pinnedResult.canDelete).toBe(false);
  });
});
