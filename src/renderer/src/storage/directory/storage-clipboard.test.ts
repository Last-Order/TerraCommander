import { describe, expect, it } from 'vitest';
import type { Capabilities, Entry, EntryRef } from '@shared/storage';
import { localConnectionId } from '@shared/storage-browser';
import { validatePaste, type StorageClipboard } from './storage-clipboard';

function ref(connectionId: string, locator: string, spaceId = 'space-1'): EntryRef {
  return { connectionId, spaceId, locator };
}

function entry(
  kind: 'file' | 'directory',
  connectionId: string,
  locator: string,
  name = locator,
): Entry {
  return { kind, ref: ref(connectionId, locator), name, capabilities: {} };
}

function clipboard(
  mode: 'copy' | 'cut',
  sourceParent: EntryRef,
  entries: readonly Entry[],
): StorageClipboard {
  return { mode, sourceParent, sourceDirectoryPath: 'Root', entries };
}

describe('validatePaste', () => {
  it('clears a cut clipboard when pasting into the same directory', () => {
    const parent = ref(localConnectionId, 'dir-a');
    const result = validatePaste({
      clipboard: clipboard('cut', parent, [entry('file', localConnectionId, 'file-1')]),
      targetParent: parent,
      targetAncestors: [parent],
    });
    expect(result).toEqual({ status: 'clear-cut' });
  });

  it('allows copying into the same directory', () => {
    const parent = ref(localConnectionId, 'dir-a');
    const result = validatePaste({
      clipboard: clipboard('copy', parent, [entry('file', localConnectionId, 'file-1')]),
      targetParent: parent,
      targetAncestors: [parent],
    });
    expect(result).toEqual({ status: 'ok' });
  });

  it('rejects pasting between two different remote connections', () => {
    const sourceParent = ref('drive-1', 'root');
    const targetParent = ref('drive-2', 'root');
    const result = validatePaste({
      clipboard: clipboard('copy', sourceParent, [entry('file', 'drive-1', 'file-1')]),
      targetParent,
      targetAncestors: [targetParent],
    });
    expect(result).toEqual({ status: 'rejected', reason: 'crossSource' });
  });

  it('allows pasting between local and remote connections', () => {
    const sourceParent = ref(localConnectionId, 'root');
    const targetParent = ref('drive-1', 'root');
    const result = validatePaste({
      clipboard: clipboard('copy', sourceParent, [entry('file', localConnectionId, 'file-1')]),
      targetParent,
      targetAncestors: [targetParent],
    });
    expect(result).toEqual({ status: 'ok' });
  });

  it('rejects pasting a directory into itself or its descendant', () => {
    const root = ref(localConnectionId, 'root');
    const dir = ref(localConnectionId, 'dir-a');
    const child = ref(localConnectionId, 'dir-a/child');
    const result = validatePaste({
      clipboard: clipboard('copy', root, [entry('directory', localConnectionId, 'dir-a')]),
      targetParent: child,
      targetAncestors: [root, dir, child],
    });
    expect(result).toEqual({ status: 'rejected', reason: 'selfContainment' });
  });

  it('rejects pasting into a remote target without write capability', () => {
    const sourceParent = ref(localConnectionId, 'root');
    const targetParent = ref('drive-1', 'root');
    const capabilities: Capabilities = { write: { support: 'unsupported' } };
    const result = validatePaste({
      clipboard: clipboard('copy', sourceParent, [entry('file', localConnectionId, 'file-1')]),
      targetParent,
      targetAncestors: [targetParent],
      targetCapabilities: capabilities,
    });
    expect(result).toEqual({ status: 'rejected', reason: 'permissionDenied' });
  });

  it('rejects copying a directory to a remote target without createDirectory capability', () => {
    const sourceParent = ref('drive-1', 'root');
    const targetParent = ref('drive-1', 'sub');
    const capabilities: Capabilities = { createDirectory: { support: 'unsupported' } };
    const result = validatePaste({
      clipboard: clipboard('copy', sourceParent, [entry('directory', 'drive-1', 'folder-1')]),
      targetParent,
      targetAncestors: [sourceParent, targetParent],
      targetCapabilities: capabilities,
    });
    expect(result).toEqual({ status: 'rejected', reason: 'unsupported' });
  });

  it('allows cutting a directory within the same remote connection without createDirectory capability', () => {
    const sourceParent = ref('drive-1', 'root');
    const targetParent = ref('drive-1', 'sub');
    const capabilities: Capabilities = { createDirectory: { support: 'unsupported' } };
    const result = validatePaste({
      clipboard: clipboard('cut', sourceParent, [entry('directory', 'drive-1', 'folder-1')]),
      targetParent,
      targetAncestors: [sourceParent, targetParent],
      targetCapabilities: capabilities,
    });
    expect(result).toEqual({ status: 'ok' });
  });
});
