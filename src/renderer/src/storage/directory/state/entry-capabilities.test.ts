import { describe, expect, it } from 'vitest';
import type { Capabilities, Entry } from '@shared/storage';
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
    expect(resolveEntryCapabilities([], 'google-drive')).toEqual({
      canCopy: false,
      canCut: false,
      canDownload: false,
      canRename: false,
      canDelete: false,
    });
  });

  it('enables download only for non-local readable entries', () => {
    const file = makeEntry('file', 'file-1');
    const unreadable = makeEntry('file', 'file-2', {
      capabilities: { read: { support: 'unsupported' } },
    });

    expect(resolveEntryCapabilities([file], 'google-drive').canDownload).toBe(true);
    expect(resolveEntryCapabilities([file], 'local').canDownload).toBe(false);
    expect(resolveEntryCapabilities([file, unreadable], 'google-drive').canDownload).toBe(false);
  });

  it('only enables rename for a single renamable entry', () => {
    const fileA = makeEntry('file', 'a');
    const fileB = makeEntry('file', 'b');
    const readonlyFile = makeEntry('file', 'readonly', {
      capabilities: { rename: { support: 'unsupported' } },
    });

    expect(resolveEntryCapabilities([fileA], 'google-drive').canRename).toBe(true);
    expect(resolveEntryCapabilities([fileA, fileB], 'google-drive').canRename).toBe(false);
    expect(resolveEntryCapabilities([readonlyFile], 'google-drive').canRename).toBe(false);
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

    expect(resolveEntryCapabilities([link], 'google-drive')).toMatchObject({
      canCopy: false,
      canCut: true,
      canDownload: false,
      canDelete: true,
    });

    expect(resolveEntryCapabilities([pinned], 'google-drive')).toMatchObject({
      canCut: false,
      canDelete: false,
    });
  });
});
