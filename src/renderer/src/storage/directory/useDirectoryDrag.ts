import { notifications } from '@mantine/notifications';
import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent } from 'react';
import { useTranslation } from 'react-i18next';
import type { Entry } from '@shared/storage';
import type { PasteEntriesRequest } from '@shared/tasks';
import { errorKey, StorageBrowserError } from '../storage-client';
import { useStorageWorkspace } from '../storage-workspace-context';
import { useStorageTaskQueue } from '../tasks/storage-task-queue-context';
import { useCurrentDirectory } from './current-directory-context';
import {
  buildMoveIntoDirectoryRequest,
  canDragMoveEntry,
  canDropEntriesIntoTarget,
  directoryDragMimeType,
  hasDirectoryEntryDrag,
  pruneCutClipboardForMovedEntries,
  resolveDragStartEntries,
} from './directory-drag';
import { useDirectoryView, useDirectoryViewStore } from './directory-view-context';
import { useStorageClipboard } from './storage-clipboard';
import { useSelectionBusy } from './useDirectoryEffects';
import classes from './DirectoryTable.module.css';

const moveStatusNotification = 'directory-drag-move-status';

interface ActiveDirectoryDrag {
  anchorLocator: string;
  entries: readonly Entry[];
  locators: ReadonlySet<string>;
}

function closestRowElement(target: EventTarget | null): HTMLTableRowElement | null {
  if (target instanceof Element) return target.closest<HTMLTableRowElement>('tr[data-index]');
  if (target instanceof Node) {
    return target.parentElement?.closest<HTMLTableRowElement>('tr[data-index]') ?? null;
  }
  return null;
}

export function useDirectoryDrag() {
  const { t } = useTranslation(['storage', 'errors']);
  const { directoryEffects, onAuthRequired } = useStorageWorkspace();
  const queue = useStorageTaskQueue();
  const { ref: parent, path: directoryPath, ancestors } = useCurrentDirectory();
  const viewStore = useDirectoryViewStore();
  const entries = useDirectoryView((state) => state.entries);
  const selectedLocators = useDirectoryView((state) => state.selectedLocators);
  const blocked = useDirectoryView(
    (state) => state.loadingWithoutEntries || state.hasError || state.navigationBlocked,
  );
  const selectedEntries = useMemo(() => {
    const selected: Entry[] = [];
    for (const locator of selectedLocators) {
      const entry = entries.get(locator);
      if (entry) selected.push(entry);
    }
    return selected;
  }, [entries, selectedLocators]);
  const selectionBusy = useSelectionBusy(selectedEntries);
  const selectionDraggable =
    !blocked &&
    selectedEntries.length > 0 &&
    !selectionBusy &&
    selectedEntries.every(canDragMoveEntry);

  const [activeDrag, setActiveDrag] = useState<ActiveDirectoryDrag | null>(null);
  const [dropTargetLocator, setDropTargetLocator] = useState<string | null>(null);
  const activeDragRef = useRef<ActiveDirectoryDrag | null>(null);
  const previewRef = useRef<{ element: HTMLElement; frame: number } | null>(null);

  const removeDragPreview = useCallback(() => {
    const current = previewRef.current;
    if (!current) return;
    previewRef.current = null;
    cancelAnimationFrame(current.frame);
    current.element.remove();
  }, []);

  useEffect(() => removeDragPreview, [removeDragPreview]);

  const clearDrag = useCallback(() => {
    removeDragPreview();
    activeDragRef.current = null;
    setActiveDrag(null);
    setDropTargetLocator(null);
  }, [removeDragPreview]);

  const isDragging = activeDrag !== null;
  useEffect(() => {
    if (!isDragging) return;
    const handleWindowDragEnd = () => clearDrag();
    window.addEventListener('dragend', handleWindowDragEnd);
    return () => window.removeEventListener('dragend', handleWindowDragEnd);
  }, [isDragging, clearDrag]);

  const onRowDragStart = useCallback(
    (index: number, event: DragEvent<HTMLTableRowElement>) => {
      const state = viewStore.getState();
      if (state.loadingWithoutEntries || state.hasError || state.navigationBlocked) {
        event.preventDefault();
        return;
      }
      const draggedRow = state.rows[index];
      if (!draggedRow) {
        event.preventDefault();
        return;
      }
      const resolved = resolveDragStartEntries({
        draggedRow,
        rows: state.rows,
        selectedLocators: state.selectedLocators,
        isBusy: (ref) => directoryEffects.isBusy(ref),
      });
      if (!resolved) {
        event.preventDefault();
        return;
      }

      if (resolved.replaceSelectionWith !== null) {
        state.selectOnly(resolved.replaceSelectionWith);
      }

      event.dataTransfer.effectAllowed = 'move';
      event.dataTransfer.setData(
        directoryDragMimeType,
        JSON.stringify(resolved.entries.map((entry) => entry.ref.locator)),
      );

      removeDragPreview();
      const host = event.currentTarget.closest('main') ?? event.currentTarget.ownerDocument.body;
      const doc = host.ownerDocument;
      const preview = doc.createElement('div');
      if (classes.dragPreview) preview.className = classes.dragPreview;
      preview.setAttribute('aria-hidden', 'true');
      const nameSpan = doc.createElement('span');
      if (classes.dragPreviewName) nameSpan.className = classes.dragPreviewName;
      nameSpan.textContent = resolved.leadName;
      preview.append(nameSpan);
      if (resolved.entries.length > 1) {
        const countSpan = doc.createElement('span');
        if (classes.dragPreviewCount) countSpan.className = classes.dragPreviewCount;
        countSpan.textContent = String(resolved.entries.length);
        preview.append(countSpan);
      }
      host.append(preview);
      event.dataTransfer.setDragImage(preview, 12, 12);
      const frame = requestAnimationFrame(() => {
        if (previewRef.current?.element === preview) {
          previewRef.current = null;
        }
        preview.remove();
      });
      previewRef.current = { element: preview, frame };

      const nextDrag: ActiveDirectoryDrag = {
        anchorLocator: draggedRow.entry.ref.locator,
        entries: resolved.entries,
        locators: resolved.locators,
      };
      activeDragRef.current = nextDrag;
      setActiveDrag(nextDrag);
      setDropTargetLocator(null);
    },
    [viewStore, directoryEffects, removeDragPreview],
  );

  const onRowDragEnd = useCallback(() => {
    clearDrag();
  }, [clearDrag]);

  const executeMove = async (request: PasteEntriesRequest) => {
    try {
      const response = await queue.pasteEntries(request);
      if (response.status === 'rejected') {
        const notice = {
          'cross-source': { color: 'yellow', message: t('crossSourcePasteUnsupported') },
          'self-containment': { color: 'red', message: t('moveSelfContainmentError') },
          'permission-denied': { color: 'red', message: t('errors:permissionDenied') },
          unsupported: { color: 'red', message: t('errors:unsupported') },
        }[response.reason];
        notifications.show({ id: moveStatusNotification, ...notice });
        return;
      }
      if (response.status === 'conflict') {
        void queue.cancelDownloadConfirmation(response.confirmationId).catch(() => {});
        notifications.show({
          id: moveStatusNotification,
          color: 'red',
          message: t('errors:alreadyExists'),
        });
        return;
      }
      const clipboardState = useStorageClipboard.getState();
      const pruned = pruneCutClipboardForMovedEntries(
        clipboardState.clipboard,
        request.sourceParent,
        request.entries,
      );
      if (pruned !== clipboardState.clipboard) {
        clipboardState.setClipboard(pruned);
      }
    } catch (caught) {
      if (caught instanceof StorageBrowserError && caught.code === 'AuthRequired') {
        onAuthRequired();
        return;
      }
      notifications.show({
        id: moveStatusNotification,
        color: 'red',
        message: t(`errors:${errorKey(caught)}`),
      });
    }
  };

  const tableDragProps = {
    onDragOver: (event: DragEvent<HTMLTableElement>) => {
      if (!hasDirectoryEntryDrag(event.dataTransfer.types)) return;
      const active = activeDragRef.current;
      if (!active) return;
      event.preventDefault();
      event.stopPropagation();

      const rowElement = closestRowElement(event.target);
      const row = rowElement
        ? viewStore.getState().rows[Number(rowElement.dataset.index)]
        : undefined;
      const validTarget = canDropEntriesIntoTarget({
        target: row?.entry,
        draggedEntries: active.entries,
        draggedLocators: active.locators,
        isBusy: (ref) => directoryEffects.isBusy(ref),
        blocked,
      });
      event.dataTransfer.dropEffect = validTarget ? 'move' : 'none';
      const nextTargetLocator = validTarget && row ? row.entry.ref.locator : null;
      if (nextTargetLocator !== dropTargetLocator) {
        setDropTargetLocator(nextTargetLocator);
      }
    },
    onDragLeave: (event: DragEvent<HTMLTableElement>) => {
      if (!hasDirectoryEntryDrag(event.dataTransfer.types)) return;
      const { currentTarget, relatedTarget } = event;
      if (relatedTarget instanceof Node && currentTarget.contains(relatedTarget)) return;
      if (dropTargetLocator !== null) setDropTargetLocator(null);
    },
    onDrop: (event: DragEvent<HTMLTableElement>) => {
      if (!hasDirectoryEntryDrag(event.dataTransfer.types)) return;
      event.preventDefault();
      event.stopPropagation();

      const active = activeDragRef.current;
      const rowElement = closestRowElement(event.target);
      const row = rowElement
        ? viewStore.getState().rows[Number(rowElement.dataset.index)]
        : undefined;
      clearDrag();

      if (!active || !row) return;
      const validTarget = canDropEntriesIntoTarget({
        target: row.entry,
        draggedEntries: active.entries,
        draggedLocators: active.locators,
        isBusy: (ref) => directoryEffects.isBusy(ref),
        blocked,
      });
      if (!validTarget) return;

      const request = buildMoveIntoDirectoryRequest({
        parent,
        directoryPath,
        ancestors,
        entries: active.entries,
        targetDirectory: row.entry,
        targetDirectoryName: row.name,
      });
      void executeMove(request);
    },
  };

  return {
    blocked,
    selectionDraggable,
    draggingAnchorLocator: activeDrag?.anchorLocator ?? null,
    draggedLocators: activeDrag?.locators,
    dropTargetLocator,
    onRowDragStart,
    onRowDragEnd,
    tableDragProps,
  };
}

export type DirectoryDrag = ReturnType<typeof useDirectoryDrag>;
