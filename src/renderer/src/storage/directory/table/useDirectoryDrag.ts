import { notifications } from '@mantine/notifications';
import { useCallback, useEffect, useRef, useState, type DragEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { errorKey, StorageBrowserError } from '@renderer/storage/storage-client';
import { useStorageWorkspace } from '@renderer/storage/storage-workspace-context';
import { useStorageTaskQueue } from '@renderer/storage/tasks/storage-task-queue-context';
import type { Entry } from '@shared/storage';
import type { PasteEntriesRequest } from '@shared/tasks';
import { useCurrentDirectory } from '../current-directory-context';
import { useDirectoryViewStore } from '../state/directory-view-context';
import { useStorageClipboard } from '../state/storage-clipboard';
import { useSelectionBusy } from '../state/useDirectoryEffects';
import { useSelectedEntries } from '../state/useSelectedEntries';
import {
  buildMoveIntoDirectoryRequest,
  canDragMoveEntry,
  canDropEntriesIntoTarget,
  directoryDragMimeType,
  hasDirectoryEntryDrag,
  pruneCutClipboardForMovedEntries,
  resolveDragStartEntries,
} from './directory-drag';
import classes from './DirectoryTable.module.css';

const moveStatusNotification = 'directory-drag-move-status';

interface ActiveDirectoryDrag {
  anchorLocator: string;
  entries: readonly Entry[];
  locators: ReadonlySet<string>;
}

interface UseDirectoryDragOptions {
  blocked: boolean;
}

function closestRowElement(target: EventTarget | null): HTMLTableRowElement | null {
  if (target instanceof Element) return target.closest<HTMLTableRowElement>('tr[data-index]');
  if (target instanceof Node) {
    return target.parentElement?.closest<HTMLTableRowElement>('tr[data-index]') ?? null;
  }
  return null;
}

export function useDirectoryDrag({ blocked }: UseDirectoryDragOptions) {
  const { t } = useTranslation(['storage', 'errors']);
  const { directoryEffects, onAuthRequired } = useStorageWorkspace();
  const queue = useStorageTaskQueue();
  const { ref: parent, path: directoryPath, ancestors } = useCurrentDirectory();
  const viewStore = useDirectoryViewStore();
  const selectedEntries = useSelectedEntries();
  const selectionBusy = useSelectionBusy(selectedEntries);
  const selectionDraggable =
    selectedEntries.length > 0 && !selectionBusy && selectedEntries.every(canDragMoveEntry);

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

  useEffect(
    () =>
      viewStore.subscribe((state) => {
        const current = activeDragRef.current;
        if (current && !state.rowIndexByLocator.has(current.anchorLocator)) {
          clearDrag();
        }
      }),
    [viewStore, clearDrag],
  );

  const onRowDragStart = useCallback(
    (index: number, event: DragEvent<HTMLTableRowElement>) => {
      const state = viewStore.getState();
      const draggedRow = state.rows[index];
      if (!draggedRow || blocked) {
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
      event.dataTransfer.setData(directoryDragMimeType, '1');

      removeDragPreview();
      const host = event.currentTarget.closest('main') ?? event.currentTarget.ownerDocument.body;
      const doc = host.ownerDocument;
      const preview = doc.createElement('div');
      if (classes.dragPreview) preview.className = classes.dragPreview;
      preview.setAttribute('aria-hidden', 'true');
      const nameSpan = doc.createElement('span');
      if (classes.dragPreviewName) nameSpan.className = classes.dragPreviewName;
      nameSpan.textContent = draggedRow.name;
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
    [viewStore, blocked, directoryEffects, removeDragPreview],
  );

  const executeMove = async (request: PasteEntriesRequest) => {
    try {
      const response = await queue.pasteEntries(request);
      if (response.status === 'rejected') {
        const notice = {
          'self-containment': { color: 'red', message: t('moveSelfContainmentError') },
          'permission-denied': { color: 'red', message: t('errors:permissionDenied') },
          unsupported: { color: 'red', message: t('errors:unsupported') },
        }[response.reason];
        notifications.show({ id: moveStatusNotification, ...notice });
        return;
      }
      if (response.status === 'conflict') {
        void queue.cancelTransferConfirmation(response.confirmationId).catch(() => {});
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

  const resolveDropTarget = (target: EventTarget | null, drag: ActiveDirectoryDrag) => {
    const state = viewStore.getState();
    if (!state.rowIndexByLocator.has(drag.anchorLocator)) return undefined;
    const rowElement = closestRowElement(target);
    const row = rowElement ? state.rows[Number(rowElement.dataset.index)] : undefined;
    const validTarget = canDropEntriesIntoTarget({
      target: row?.entry,
      draggedEntries: drag.entries,
      draggedLocators: drag.locators,
      isBusy: (ref) => directoryEffects.isBusy(ref),
      blocked,
    });
    return validTarget ? row : undefined;
  };

  const tableDragProps = {
    onDragEnd: clearDrag,
    onDragOver: (event: DragEvent<HTMLTableElement>) => {
      const drag = activeDragRef.current;
      if (!drag || !hasDirectoryEntryDrag(event.dataTransfer.types)) return;
      event.preventDefault();
      event.stopPropagation();

      const row = resolveDropTarget(event.target, drag);
      event.dataTransfer.dropEffect = row ? 'move' : 'none';
      setDropTargetLocator(row?.entry.ref.locator ?? null);
    },
    onDragLeave: (event: DragEvent<HTMLTableElement>) => {
      if (!hasDirectoryEntryDrag(event.dataTransfer.types)) return;
      const { currentTarget, relatedTarget } = event;
      if (relatedTarget instanceof Node && currentTarget.contains(relatedTarget)) return;
      setDropTargetLocator(null);
    },
    onDrop: (event: DragEvent<HTMLTableElement>) => {
      if (!hasDirectoryEntryDrag(event.dataTransfer.types)) return;
      event.preventDefault();
      event.stopPropagation();

      const drag = activeDragRef.current;
      clearDrag();

      if (!drag) return;
      const row = resolveDropTarget(event.target, drag);
      if (!row) return;

      const request = buildMoveIntoDirectoryRequest({
        parent,
        directoryPath,
        ancestors,
        entries: drag.entries,
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
    tableDragProps,
  };
}
