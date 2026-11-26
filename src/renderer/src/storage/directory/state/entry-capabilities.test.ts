import { describe, expect, it } from 'vitest';
import type { Capabilities, Entry } from '@shared/storage';
import { localConnectionId } from '@shared/storage-browser';
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

describe('resolveEntryCapabilities', () => {
  it('disables all actions when nothing is selected', () => {
    expect(resolveEntryCapabilities([])).toEqual({
      canCopy: false,
      canCut: false,
      canDownload: false,
      canRename: false,
      canDelete: false,
    });
  });

  it('enables download only when every selected entry is remote and readable', () => {
    const remoteFile = makeEntry('file', 'remote-file');
    const localFile = makeEntry('file', 'local-file', { connectionId: localConnectionId });

    expect(resolveEntryCapabilities([remoteFile]).canDownload).toBe(true);
    expect(resolveEntryCapabilities([localFile]).canDownload).toBe(false);
    expect(resolveEntryCapabilities([remoteFile, localFile]).canDownload).toBe(false);
  });

  it('only enables rename for a single renamable entry', () => {
    const fileA = makeEntry('file', 'a');
    const fileB = makeEntry('file', 'b');
    const readonlyFile = makeEntry('file', 'readonly', {
      capabilities: { rename: { support: 'unsupported' } },
    });

    expect(resolveEntryCapabilities([fileA]).canRename).toBe(true);
    expect(resolveEntryCapabilities([fileA, fileB]).canRename).toBe(false);
    expect(resolveEntryCapabilities([readonlyFile]).canRename).toBe(false);
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

    expect(resolveEntryCapabilities([link])).toMatchObject({
      canCopy: false,
      canCut: true,
      canDownload: false,
      canDelete: true,
    });

    expect(resolveEntryCapabilities([pinned])).toMatchObject({
      canCut: false,
      canDelete: false,
    });
  });
});
