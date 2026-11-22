import { describe, expect, it } from 'vitest';
import type { Capabilities, Entry } from '@shared/storage';
import { localConnectionId } from '@shared/storage-browser';
import type { PendingEntryEffect } from '../tasks/pending-entry-effects';
import { resolveEntryCapabilities } from './entry-capabilities';

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

describe('resolveEntryCapabilities', () => {
  it('disables all actions when nothing is selected or locators are missing', () => {
    const entries = entryMap(makeEntry('file', 'a'));
    expect(resolveEntryCapabilities(entries, new Set(['missing']), new Map())).toEqual({
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

  it('enables download only when every selected entry is remote and readable', () => {
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

    expect(resolveEntryCapabilities(entries, new Set(['a']), pending)).toMatchObject({
      canRename: true,
      renamableEntry: fileA,
      renamePending: true,
      selectionBusy: true,
    });

    expect(resolveEntryCapabilities(entries, new Set(['a', 'b']), pending)).toMatchObject({
      canRename: false,
      renamableEntry: undefined,
      renamePending: false,
      selectionBusy: true,
    });
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

    expect(resolveEntryCapabilities(entries, new Set(['shortcut']), new Map())).toMatchObject({
      canCopy: false,
      canCut: true,
      canDownload: false,
      canDelete: true,
    });

    expect(resolveEntryCapabilities(entries, new Set(['pinned']), new Map())).toMatchObject({
      canCut: false,
      canDelete: false,
    });
  });
});
