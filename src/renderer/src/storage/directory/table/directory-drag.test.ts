import { describe, expect, it } from 'vitest';
import type { Capabilities, Entry, EntryRef } from '@shared/storage';
import type { DirectoryRow } from '../directory-types';
import type { StorageClipboard } from '../state/storage-clipboard';
import {
  buildMoveIntoDirectoryRequest,
  canDragMoveEntry,
  canDropEntriesIntoTarget,
  canRowStartDrag,
  directoryDragMimeType,
  hasDirectoryEntryDrag,
  pruneCutClipboardForMovedEntries,
  resolveDragStartEntries,
} from './directory-drag';

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

function row(item: Entry): DirectoryRow {
  return {
    entry: item,
    name: item.name,
    modifiedAt: undefined,
    size: undefined,
  };
}

describe('hasDirectoryEntryDrag', () => {
  it('detects the internal directory drag MIME type', () => {
    expect(hasDirectoryEntryDrag(['Files', directoryDragMimeType])).toBe(true);
    expect(hasDirectoryEntryDrag(['Files'])).toBe(false);
  });
});

describe('canDragMoveEntry and canRowStartDrag', () => {
  it('allows files, directories, and links unless moveWithin is unsupported', () => {
    expect(canDragMoveEntry(entry('a', 'file'))).toBe(true);
    expect(canDragMoveEntry(entry('b', 'directory'))).toBe(true);
    expect(canDragMoveEntry(entry('c', 'link'))).toBe(true);
    expect(canDragMoveEntry(entry('d', 'other'))).toBe(false);
    expect(canDragMoveEntry(entry('e', 'file', { moveWithin: { support: 'unsupported' } }))).toBe(
      false,
    );
  });

  it('respects blocked, busy, and selected-group state in canRowStartDrag', () => {
    const file = entry('a', 'file');
    expect(
      canRowStartDrag({
        entry: file,
        entryBusy: false,
        selected: false,
        selectionDraggable: false,
        blocked: false,
      }),
    ).toBe(true);
    expect(
      canRowStartDrag({
        entry: file,
        entryBusy: true,
        selected: false,
        selectionDraggable: true,
        blocked: false,
      }),
    ).toBe(false);
    expect(
      canRowStartDrag({
        entry: file,
        entryBusy: false,
        selected: false,
        selectionDraggable: true,
        blocked: true,
      }),
    ).toBe(false);
    expect(
      canRowStartDrag({
        entry: file,
        entryBusy: false,
        selected: true,
        selectionDraggable: false,
        blocked: false,
      }),
    ).toBe(false);
    expect(
      canRowStartDrag({
        entry: file,
        entryBusy: false,
        selected: true,
        selectionDraggable: true,
        blocked: false,
      }),
    ).toBe(true);
  });
});

describe('resolveDragStartEntries', () => {
  it('drags all selected entries in row order when dragging a selected row', () => {
    const folder = entry('dir-1', 'directory', {}, 'Folder');
    const fileA = entry('file-a', 'file', {}, 'a.txt');
    const fileB = entry('file-b', 'file', {}, 'b.txt');
    const rows = [row(folder), row(fileA), row(fileB)];

    const result = resolveDragStartEntries({
      draggedRow: rows[1]!,
      rows,
      selectedLocators: new Set(['file-b', 'dir-1', 'file-a']),
      isBusy: () => false,
    });

    expect(result).toEqual({
      entries: [folder, fileA, fileB],
      locators: new Set(['dir-1', 'file-a', 'file-b']),
      replaceSelectionWith: null,
    });
  });

  it('rejects multi-selection drag when any selected entry is busy or unmovable', () => {
    const fileA = entry('file-a', 'file');
    const locked = entry('file-b', 'file', { moveWithin: { support: 'unsupported' } });
    const rows = [row(fileA), row(locked)];

    expect(
      resolveDragStartEntries({
        draggedRow: rows[0]!,
        rows,
        selectedLocators: new Set(['file-a', 'file-b']),
        isBusy: () => false,
      }),
    ).toBeNull();

    const busyFile = entry('file-c', 'file');
    const rowsWithBusy = [row(fileA), row(busyFile)];
    expect(
      resolveDragStartEntries({
        draggedRow: rowsWithBusy[0]!,
        rows: rowsWithBusy,
        selectedLocators: new Set(['file-a', 'file-c']),
        isBusy: (itemRef) => itemRef.locator === 'file-c',
      }),
    ).toBeNull();
  });

  it('selects and drags a single unselected movable row', () => {
    const fileA = entry('file-a', 'file');
    const fileB = entry('file-b', 'file');
    const rows = [row(fileA), row(fileB)];

    expect(
      resolveDragStartEntries({
        draggedRow: rows[1]!,
        rows,
        selectedLocators: new Set(['file-a']),
        isBusy: () => false,
      }),
    ).toEqual({
      entries: [fileB],
      locators: new Set(['file-b']),
      replaceSelectionWith: 'file-b',
    });
  });

  it('rejects dragging an unselected unmovable or busy row', () => {
    const locked = entry('locked', 'file', { moveWithin: { support: 'unsupported' } });
    const busy = entry('busy', 'file');
    const rows = [row(locked), row(busy)];

    expect(
      resolveDragStartEntries({
        draggedRow: rows[0]!,
        rows,
        selectedLocators: new Set(),
        isBusy: () => false,
      }),
    ).toBeNull();

    expect(
      resolveDragStartEntries({
        draggedRow: rows[1]!,
        rows,
        selectedLocators: new Set(),
        isBusy: (itemRef) => itemRef.locator === 'busy',
      }),
    ).toBeNull();
  });
});

describe('canDropEntriesIntoTarget', () => {
  it('accepts a writable non-busy folder that is not part of the dragged selection', () => {
    const draggedFile = entry('file-1', 'file');
    const targetFolder = entry('dir-1', 'directory', { write: { support: 'supported' } });

    expect(
      canDropEntriesIntoTarget({
        target: targetFolder,
        draggedEntries: [draggedFile],
        draggedLocators: new Set(['file-1']),
        isBusy: () => false,
        blocked: false,
      }),
    ).toBe(true);
  });

  it('rejects non-directories, read-only folders, self-drops, busy items, and blocked state', () => {
    const draggedFile = entry('file-1', 'file');
    const draggedFolder = entry('dir-1', 'directory');
    const writableFolder = entry('dir-2', 'directory', { write: { support: 'supported' } });
    const readOnlyFolder = entry('dir-ro', 'directory', { write: { support: 'unsupported' } });
    const targetFile = entry('file-2', 'file');
    const targetLink = entry('link-1', 'link');

    expect(
      canDropEntriesIntoTarget({
        target: targetFile,
        draggedEntries: [draggedFile],
        draggedLocators: new Set(['file-1']),
        isBusy: () => false,
        blocked: false,
      }),
    ).toBe(false);

    expect(
      canDropEntriesIntoTarget({
        target: targetLink,
        draggedEntries: [draggedFile],
        draggedLocators: new Set(['file-1']),
        isBusy: () => false,
        blocked: false,
      }),
    ).toBe(false);

    expect(
      canDropEntriesIntoTarget({
        target: readOnlyFolder,
        draggedEntries: [draggedFile],
        draggedLocators: new Set(['file-1']),
        isBusy: () => false,
        blocked: false,
      }),
    ).toBe(false);

    // Self-drop multi-select
    expect(
      canDropEntriesIntoTarget({
        target: draggedFolder,
        draggedEntries: [draggedFile, draggedFolder],
        draggedLocators: new Set(['file-1', 'dir-1']),
        isBusy: () => false,
        blocked: false,
      }),
    ).toBe(false);

    // Target busy
    expect(
      canDropEntriesIntoTarget({
        target: writableFolder,
        draggedEntries: [draggedFile],
        draggedLocators: new Set(['file-1']),
        isBusy: (itemRef) => itemRef.locator === 'dir-2',
        blocked: false,
      }),
    ).toBe(false);

    // Source busy
    expect(
      canDropEntriesIntoTarget({
        target: writableFolder,
        draggedEntries: [draggedFile],
        draggedLocators: new Set(['file-1']),
        isBusy: (itemRef) => itemRef.locator === 'file-1',
        blocked: false,
      }),
    ).toBe(false);

    // Blocked
    expect(
      canDropEntriesIntoTarget({
        target: writableFolder,
        draggedEntries: [draggedFile],
        draggedLocators: new Set(['file-1']),
        isBusy: () => false,
        blocked: true,
      }),
    ).toBe(false);
  });
});

describe('buildMoveIntoDirectoryRequest', () => {
  it('builds a cut paste request targeting the dropped folder', () => {
    const rootRef = ref('root');
    const parentRef = ref('parent');
    const file = entry('file-1', 'file', {}, 'notes.txt');
    const target = entry('folder-1', 'directory', {}, 'Projects');

    expect(
      buildMoveIntoDirectoryRequest({
        parent: parentRef,
        directoryPath: 'My Drive / Work',
        ancestors: [rootRef, parentRef],
        entries: [file],
        targetDirectory: target,
        targetDirectoryName: 'Renamed Projects',
      }),
    ).toEqual({
      mode: 'cut',
      sourceParent: parentRef,
      sourceDirectoryPath: 'My Drive / Work',
      entries: [file],
      targetParent: target.ref,
      targetDirectoryPath: 'My Drive / Work / Renamed Projects',
      targetAncestors: [rootRef, parentRef, target.ref],
    });
  });
});

describe('pruneCutClipboardForMovedEntries', () => {
  it('prunes moved entries from matching cut clipboard and keeps copy or unrelated clipboards', () => {
    const parent = ref('parent');
    const otherParent = ref('other');
    const fileA = entry('a');
    const fileB = entry('b');
    const cutClipboard: StorageClipboard = {
      mode: 'cut',
      sourceParent: parent,
      sourceDirectoryPath: 'Work',
      entries: [fileA, fileB],
    };

    expect(pruneCutClipboardForMovedEntries(cutClipboard, parent, [fileA])).toEqual({
      ...cutClipboard,
      entries: [fileB],
    });
    expect(pruneCutClipboardForMovedEntries(cutClipboard, parent, [fileA, fileB])).toBeNull();
    expect(pruneCutClipboardForMovedEntries(cutClipboard, otherParent, [fileA])).toBe(cutClipboard);

    const copyClipboard: StorageClipboard = { ...cutClipboard, mode: 'copy' };
    expect(pruneCutClipboardForMovedEntries(copyClipboard, parent, [fileA])).toBe(copyClipboard);
    expect(pruneCutClipboardForMovedEntries(null, parent, [fileA])).toBeNull();
  });
});
