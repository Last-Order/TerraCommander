import { describe, expect, it } from 'vitest';
import type { Capabilities, Entry, EntryRef } from '@shared/storage';
import type { DirectoryRow } from '../directory-types';
import { directoryDragMimeType } from '../table/directory-drag';
import {
  buildLocalPathsDropRequest,
  canDropLocalFilesIntoDirectory,
  hasExternalFileDrag,
  isSameLocalFileDropTarget,
  resolveLocalFileDropTarget,
  type LocalFileDropTarget,
} from './directory-upload';

function ref(locator: string, overrides: Partial<EntryRef> = {}): EntryRef {
  return {
    connectionId: 'drive-1',
    spaceId: 'space-1',
    locator,
    ...overrides,
  };
}

function entry(
  locator: string,
  kind: Entry['kind'] = 'file',
  capabilities: Capabilities = {},
  name = locator,
): Entry {
  return {
    ref: ref(locator),
    name,
    kind,
    capabilities,
  };
}

function row(item: Entry, name = item.name): DirectoryRow {
  return {
    entry: item,
    name,
    modifiedAt: undefined,
    size: undefined,
  };
}

describe('hasExternalFileDrag', () => {
  it('detects external file drags while ignoring internal entry drags', () => {
    expect(hasExternalFileDrag(['Files'])).toBe(true);
    expect(hasExternalFileDrag(['text/plain', 'Files'])).toBe(true);
    expect(hasExternalFileDrag(['text/plain'])).toBe(false);
    expect(hasExternalFileDrag(['Files', directoryDragMimeType])).toBe(false);
  });
});

describe('canDropLocalFilesIntoDirectory', () => {
  it('accepts writable non-busy directories and rejects others', () => {
    const writableDir = entry('dir-1', 'directory', { write: { support: 'supported' } });
    const defaultDir = entry('dir-2', 'directory');
    const readOnlyDir = entry('dir-ro', 'directory', { write: { support: 'unsupported' } });
    const file = entry('file-1', 'file');
    const link = entry('link-1', 'link');

    expect(canDropLocalFilesIntoDirectory(writableDir, () => false)).toBe(true);
    expect(canDropLocalFilesIntoDirectory(defaultDir, () => false)).toBe(true);
    expect(canDropLocalFilesIntoDirectory(readOnlyDir, () => false)).toBe(false);
    expect(
      canDropLocalFilesIntoDirectory(writableDir, (itemRef) => itemRef.locator === 'dir-1'),
    ).toBe(false);
    expect(canDropLocalFilesIntoDirectory(file, () => false)).toBe(false);
    expect(canDropLocalFilesIntoDirectory(link, () => false)).toBe(false);
  });
});

describe('resolveLocalFileDropTarget', () => {
  it('targets a hovered writable folder even when the current directory is read-only', () => {
    const folder = entry('dir-1', 'directory', { write: { support: 'supported' } }, 'Photos');

    expect(
      resolveLocalFileDropTarget({
        hoveredRow: row(folder, 'Vacation Photos'),
        canDropInCurrentDirectory: false,
        isBusy: () => false,
        disabled: false,
      }),
    ).toEqual({
      kind: 'folder',
      entry: folder,
      name: 'Vacation Photos',
    });
  });

  it('rejects hovered read-only or busy folders instead of falling back to the current directory', () => {
    const readOnlyFolder = entry('dir-ro', 'directory', { write: { support: 'unsupported' } });
    const busyFolder = entry('dir-busy', 'directory');

    expect(
      resolveLocalFileDropTarget({
        hoveredRow: row(readOnlyFolder),
        canDropInCurrentDirectory: true,
        isBusy: () => false,
        disabled: false,
      }),
    ).toBeNull();

    expect(
      resolveLocalFileDropTarget({
        hoveredRow: row(busyFolder),
        canDropInCurrentDirectory: true,
        isBusy: (itemRef) => itemRef.locator === 'dir-busy',
        disabled: false,
      }),
    ).toBeNull();
  });

  it('targets the current directory for blank space and non-directory rows when writable', () => {
    const file = entry('file-1', 'file');
    const link = entry('link-1', 'link');

    expect(
      resolveLocalFileDropTarget({
        hoveredRow: undefined,
        canDropInCurrentDirectory: true,
        isBusy: () => false,
        disabled: false,
      }),
    ).toEqual({ kind: 'current-directory' });

    expect(
      resolveLocalFileDropTarget({
        hoveredRow: row(file),
        canDropInCurrentDirectory: true,
        isBusy: () => false,
        disabled: false,
      }),
    ).toEqual({ kind: 'current-directory' });

    expect(
      resolveLocalFileDropTarget({
        hoveredRow: row(link),
        canDropInCurrentDirectory: true,
        isBusy: () => false,
        disabled: false,
      }),
    ).toEqual({ kind: 'current-directory' });

    expect(
      resolveLocalFileDropTarget({
        hoveredRow: row(file),
        canDropInCurrentDirectory: false,
        isBusy: () => false,
        disabled: false,
      }),
    ).toBeNull();
  });

  it('rejects all targets when disabled', () => {
    const folder = entry('dir-1', 'directory');

    expect(
      resolveLocalFileDropTarget({
        hoveredRow: row(folder),
        canDropInCurrentDirectory: true,
        isBusy: () => false,
        disabled: true,
      }),
    ).toBeNull();

    expect(
      resolveLocalFileDropTarget({
        hoveredRow: undefined,
        canDropInCurrentDirectory: true,
        isBusy: () => false,
        disabled: true,
      }),
    ).toBeNull();
  });
});

describe('isSameLocalFileDropTarget', () => {
  it('compares null, current-directory, and folder targets accurately', () => {
    const dirA = entry('dir-a', 'directory', {}, 'A');
    const dirB = entry('dir-b', 'directory', {}, 'B');
    const current: LocalFileDropTarget = { kind: 'current-directory' };
    const folderA: LocalFileDropTarget = { kind: 'folder', entry: dirA, name: 'A' };
    const folderARenamed: LocalFileDropTarget = { kind: 'folder', entry: dirA, name: 'A2' };
    const folderB: LocalFileDropTarget = { kind: 'folder', entry: dirB, name: 'B' };

    expect(isSameLocalFileDropTarget(null, null)).toBe(true);
    expect(isSameLocalFileDropTarget(current, { kind: 'current-directory' })).toBe(true);
    expect(isSameLocalFileDropTarget(folderA, { kind: 'folder', entry: dirA, name: 'A' })).toBe(
      true,
    );
    expect(isSameLocalFileDropTarget(folderA, folderARenamed)).toBe(false);
    expect(isSameLocalFileDropTarget(folderA, folderB)).toBe(false);
    expect(isSameLocalFileDropTarget(folderA, current)).toBe(false);
    expect(isSameLocalFileDropTarget(current, null)).toBe(false);
  });
});

describe('buildLocalPathsDropRequest', () => {
  it('targets the current directory or the hovered folder with updated path and ancestors', () => {
    const rootRef = ref('root');
    const parentRef = ref('parent');
    const folder = entry('dir-1', 'directory', {}, 'Projects');
    const paths = ['C:\\Users\\demo\\report.pdf'];

    expect(
      buildLocalPathsDropRequest({
        target: { kind: 'current-directory' },
        parent: parentRef,
        directoryPath: 'My Drive / Work',
        targetAncestors: [rootRef, parentRef],
        paths,
      }),
    ).toEqual({
      targetParent: parentRef,
      targetDirectoryPath: 'My Drive / Work',
      paths,
      targetAncestors: [rootRef, parentRef],
    });

    expect(
      buildLocalPathsDropRequest({
        target: { kind: 'folder', entry: folder, name: 'Projects' },
        parent: parentRef,
        directoryPath: 'My Drive / Work',
        targetAncestors: [rootRef, parentRef],
        paths,
      }),
    ).toEqual({
      targetParent: folder.ref,
      targetDirectoryPath: 'My Drive / Work / Projects',
      paths,
      targetAncestors: [rootRef, parentRef, folder.ref],
    });

    expect(
      buildLocalPathsDropRequest({
        target: { kind: 'folder', entry: folder, name: 'Projects' },
        parent: parentRef,
        directoryPath: '',
        targetAncestors: [parentRef],
        paths,
      }),
    ).toEqual({
      targetParent: folder.ref,
      targetDirectoryPath: 'Projects',
      paths,
      targetAncestors: [parentRef, folder.ref],
    });
  });
});
