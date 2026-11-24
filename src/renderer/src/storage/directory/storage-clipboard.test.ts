import { describe, expect, it } from 'vitest';
import type { Entry, EntryRef } from '@shared/storage';
import { localConnectionId } from '@shared/storage-browser';
import { validatePaste, type StorageClipboard } from './storage-clipboard';

function ref(connectionId: string, locator: string, spaceId = 'space-1'): EntryRef {
  return { connectionId, spaceId, locator };
}

function entry(kind: 'file' | 'directory', connectionId: string, locator: string): Entry {
  return { kind, ref: ref(connectionId, locator), name: locator, capabilities: {} };
}

function clipboard(
  mode: 'copy' | 'cut',
  sourceParent: EntryRef,
  entries: readonly Entry[],
): StorageClipboard {
  return { mode, sourceParent, sourceDirectoryPath: 'Root', entries };
}

describe('validatePaste', () => {
  it('clears a cut clipboard on same-directory paste while allowing same-directory copy', () => {
    const parent = ref(localConnectionId, 'dir-a');
    const file = entry('file', localConnectionId, 'file-1');

    expect(
      validatePaste({
        clipboard: clipboard('cut', parent, [file]),
        targetParent: parent,
        targetAncestors: [parent],
      }),
    ).toEqual({ status: 'clear-cut' });

    expect(
      validatePaste({
        clipboard: clipboard('copy', parent, [file]),
        targetParent: parent,
        targetAncestors: [parent],
      }),
    ).toEqual({ status: 'ok' });
  });

  it('rejects pasting between two remote connections while allowing local-to-remote transfers', () => {
    const targetParent = ref('drive-2', 'root');

    expect(
      validatePaste({
        clipboard: clipboard('copy', ref('drive-1', 'root'), [entry('file', 'drive-1', 'file-1')]),
        targetParent,
        targetAncestors: [targetParent],
      }),
    ).toEqual({ status: 'rejected', reason: 'crossSource' });

    expect(
      validatePaste({
        clipboard: clipboard('copy', ref(localConnectionId, 'root'), [
          entry('file', localConnectionId, 'file-1'),
        ]),
        targetParent,
        targetAncestors: [targetParent],
      }),
    ).toEqual({ status: 'ok' });
  });

  it('rejects pasting a directory into itself or its descendant', () => {
    const root = ref(localConnectionId, 'root');
    const dir = ref(localConnectionId, 'dir-a');
    const child = ref(localConnectionId, 'dir-a/child');

    expect(
      validatePaste({
        clipboard: clipboard('copy', root, [entry('directory', localConnectionId, 'dir-a')]),
        targetParent: child,
        targetAncestors: [root, dir, child],
      }),
    ).toEqual({ status: 'rejected', reason: 'selfContainment' });
  });

  it('enforces write and createDirectory capabilities for both remote and local targets', () => {
    const remoteRoot = ref('drive-1', 'root');
    const remoteSub = ref('drive-1', 'sub');
    const remoteFolder = entry('directory', 'drive-1', 'folder-1');
    const localRoot = ref(localConnectionId, 'root');
    const localSub = ref(localConnectionId, 'sub');
    const localFile = entry('file', localConnectionId, 'file-1');
    const localFolder = entry('directory', localConnectionId, 'folder-1');

    expect(
      validatePaste({
        clipboard: clipboard('copy', localRoot, [localFile]),
        targetParent: remoteRoot,
        targetAncestors: [remoteRoot],
        targetCapabilities: { write: { support: 'unsupported' } },
      }),
    ).toEqual({ status: 'rejected', reason: 'permissionDenied' });

    expect(
      validatePaste({
        clipboard: clipboard('copy', localRoot, [localFile]),
        targetParent: localSub,
        targetAncestors: [localRoot, localSub],
        targetCapabilities: { write: { support: 'unsupported' } },
      }),
    ).toEqual({ status: 'rejected', reason: 'permissionDenied' });

    expect(
      validatePaste({
        clipboard: clipboard('copy', remoteRoot, [remoteFolder]),
        targetParent: localSub,
        targetAncestors: [localRoot, localSub],
        targetCapabilities: { write: { support: 'unsupported' } },
      }),
    ).toEqual({ status: 'rejected', reason: 'permissionDenied' });

    expect(
      validatePaste({
        clipboard: clipboard('copy', remoteRoot, [remoteFolder]),
        targetParent: remoteSub,
        targetAncestors: [remoteRoot, remoteSub],
        targetCapabilities: { createDirectory: { support: 'unsupported' } },
      }),
    ).toEqual({ status: 'rejected', reason: 'unsupported' });

    expect(
      validatePaste({
        clipboard: clipboard('copy', localRoot, [localFolder]),
        targetParent: localSub,
        targetAncestors: [localRoot, localSub],
        targetCapabilities: { createDirectory: { support: 'unsupported' } },
      }),
    ).toEqual({ status: 'rejected', reason: 'unsupported' });

    expect(
      validatePaste({
        clipboard: clipboard('cut', remoteRoot, [remoteFolder]),
        targetParent: localSub,
        targetAncestors: [localRoot, localSub],
        targetCapabilities: { createDirectory: { support: 'unsupported' } },
      }),
    ).toEqual({ status: 'rejected', reason: 'unsupported' });

    expect(
      validatePaste({
        clipboard: clipboard('cut', remoteRoot, [remoteFolder]),
        targetParent: remoteSub,
        targetAncestors: [remoteRoot, remoteSub],
        targetCapabilities: { createDirectory: { support: 'unsupported' } },
      }),
    ).toEqual({ status: 'ok' });

    expect(
      validatePaste({
        clipboard: clipboard('cut', localRoot, [localFolder]),
        targetParent: localSub,
        targetAncestors: [localRoot, localSub],
        targetCapabilities: { createDirectory: { support: 'unsupported' } },
      }),
    ).toEqual({ status: 'ok' });

    expect(
      validatePaste({
        clipboard: clipboard('copy', localRoot, [localFolder]),
        targetParent: localSub,
        targetAncestors: [localRoot, localSub],
        targetCapabilities: {
          write: { support: 'unknown' },
          createDirectory: { support: 'unknown' },
        },
      }),
    ).toEqual({ status: 'ok' });
  });
});
