import { notifications } from '@mantine/notifications';
import { useEffect, useRef, useState, type DragEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { errorKey } from '@renderer/storage/storage-client';
import { useStorageWorkspace } from '@renderer/storage/storage-workspace-context';
import { useStorageTaskQueue } from '@renderer/storage/tasks/storage-task-queue-context';
import type { PasteEntriesResponse } from '@shared/tasks';
import { useCurrentDirectory } from '../current-directory-context';
import type { DirectoryTransferConflictModal } from '../modals/DirectoryEntryModals';
import { useDirectoryViewStore } from '../state/directory-view-context';
import {
  buildLocalPathsDropRequest,
  canDropLocalFilesIntoDirectory,
  hasExternalFileDrag,
  isSameLocalFileDropTarget,
  resolveLocalFileDropTarget,
  type LocalFileDropTarget,
} from './directory-upload';

const uploadErrorNotification = 'directory-upload-error';

interface DirectoryUploadOptions {
  blocked: boolean;
}

interface UploadConflictState {
  confirmationId: string;
  conflicts?: readonly string[] | undefined;
  busy: boolean;
}

function closestRowElement(target: EventTarget | null): HTMLTableRowElement | null {
  if (target instanceof Element) return target.closest<HTMLTableRowElement>('tr[data-index]');
  if (target instanceof Node) {
    return target.parentElement?.closest<HTMLTableRowElement>('tr[data-index]') ?? null;
  }
  return null;
}

export function useDirectoryUpload({ blocked }: DirectoryUploadOptions) {
  const { t } = useTranslation(['storage', 'errors']);
  const { directoryEffects, onAuthRequired } = useStorageWorkspace();
  const queue = useStorageTaskQueue();
  const viewStore = useDirectoryViewStore();
  const {
    ref: parent,
    provider,
    path: directoryPath,
    ancestors: targetAncestors,
    canDropLocalFiles,
  } = useCurrentDirectory();
  const [pending, setPending] = useState(false);
  const [dropTarget, setDropTarget] = useState<LocalFileDropTarget | null>(null);
  const [conflict, setConflict] = useState<UploadConflictState | null>(null);
  const conflictIdRef = useRef<string | null>(null);
  const disabled = blocked || pending;
  const activeDropTarget =
    disabled || (dropTarget?.kind === 'current-directory' && !canDropLocalFiles)
      ? null
      : dropTarget;

  useEffect(() => {
    conflictIdRef.current = conflict?.confirmationId ?? null;
  }, [conflict]);

  useEffect(() => {
    return () => {
      const pendingId = conflictIdRef.current;
      if (pendingId !== null) {
        conflictIdRef.current = null;
        void queue.cancelTransferConfirmation(pendingId).catch(() => {});
      }
    };
  }, [queue]);

  useEffect(() => {
    if (activeDropTarget?.kind !== 'folder') return;
    const locator = activeDropTarget.entry.ref.locator;
    const syncFolderTarget = () => {
      const state = viewStore.getState();
      const index = state.rowIndexByLocator.get(locator);
      const row = index !== undefined ? state.rows[index] : undefined;
      const next: LocalFileDropTarget | null =
        row && canDropLocalFilesIntoDirectory(row.entry, (ref) => directoryEffects.isBusy(ref))
          ? { kind: 'folder', entry: row.entry, name: row.name }
          : null;
      setDropTarget((current) => (isSameLocalFileDropTarget(current, next) ? current : next));
    };
    const unsubscribeView = viewStore.subscribe(syncFolderTarget);
    const unsubscribeBusy = directoryEffects.subscribeBusy(syncFolderTarget);
    return () => {
      unsubscribeView();
      unsubscribeBusy();
    };
  }, [activeDropTarget, viewStore, directoryEffects]);

  const handleFailure = (failure: unknown) => {
    const code = errorKey(failure);
    if (code !== 'cancelled') {
      notifications.show({
        id: uploadErrorNotification,
        color: 'red',
        message: t(`errors:${code}`),
      });
    }
    if (code === 'authRequired') onAuthRequired();
  };

  const startTransfer = async (run: () => Promise<PasteEntriesResponse>) => {
    setPending(true);
    try {
      const response = await run();
      if (response.status === 'rejected') {
        const message = {
          'self-containment': t('pasteSelfContainmentError'),
          'permission-denied': t('errors:permissionDenied'),
          unsupported: t('errors:unsupported'),
        }[response.reason];
        notifications.show({
          id: uploadErrorNotification,
          color: 'red',
          message,
        });
        return;
      }
      if (response.status === 'conflict') {
        setConflict({
          confirmationId: response.confirmationId,
          conflicts: response.conflicts,
          busy: false,
        });
      }
    } catch (failure) {
      handleFailure(failure);
    } finally {
      setPending(false);
    }
  };

  const confirmConflict = () => {
    if (!conflict) return;
    const { confirmationId } = conflict;
    setConflict((current) => (current ? { ...current, busy: true } : null));
    void queue
      .confirmTransfer(confirmationId)
      .catch(handleFailure)
      .finally(() => setConflict(null));
  };

  const cancelConflict = () => {
    if (!conflict) return;
    const { confirmationId } = conflict;
    setConflict(null);
    void queue.cancelTransferConfirmation(confirmationId).catch(() => {});
  };

  const transferConflict: DirectoryTransferConflictModal | null = conflict
    ? {
        busy: conflict.busy,
        conflicts: conflict.conflicts,
        confirmLabel: t(provider === 'local' ? 'overwriteAndCopy' : 'overwriteAndUpload'),
        onConfirm: confirmConflict,
        onCancel: cancelConflict,
      }
    : null;

  const resolveDropTarget = (target: EventTarget | null): LocalFileDropTarget | null => {
    const rowElement = closestRowElement(target);
    const hoveredRow = rowElement
      ? viewStore.getState().rows[Number(rowElement.dataset.index)]
      : undefined;
    return resolveLocalFileDropTarget({
      hoveredRow,
      canDropInCurrentDirectory: canDropLocalFiles,
      isBusy: (ref) => directoryEffects.isBusy(ref),
      disabled,
    });
  };

  const updateDropTarget = (next: LocalFileDropTarget | null) => {
    setDropTarget((current) => (isSameLocalFileDropTarget(current, next) ? current : next));
  };

  const dropZoneProps = {
    onDragEnter: (event: DragEvent<HTMLElement>) => {
      if (!hasExternalFileDrag(event.dataTransfer.types)) return;
      event.preventDefault();
      const target = resolveDropTarget(event.target);
      event.dataTransfer.dropEffect = target ? 'copy' : 'none';
      updateDropTarget(target);
    },
    onDragOver: (event: DragEvent<HTMLElement>) => {
      if (!hasExternalFileDrag(event.dataTransfer.types)) return;
      event.preventDefault();
      const target = resolveDropTarget(event.target);
      event.dataTransfer.dropEffect = target ? 'copy' : 'none';
      updateDropTarget(target);
    },
    onDragLeave: (event: DragEvent<HTMLElement>) => {
      const { currentTarget, relatedTarget } = event;
      if (!(relatedTarget instanceof Node && currentTarget.contains(relatedTarget))) {
        setDropTarget(null);
      }
    },
    onDrop: (event: DragEvent<HTMLElement>) => {
      if (!hasExternalFileDrag(event.dataTransfer.types)) return;
      event.preventDefault();
      event.stopPropagation();
      const target = resolveDropTarget(event.target);
      setDropTarget(null);
      if (!target) return;
      const paths = Array.from(event.dataTransfer.files)
        .map((file) => queue.getPathForFile(file))
        .filter((path) => path.length > 0);
      if (paths.length === 0) return;
      const request = buildLocalPathsDropRequest({
        target,
        parent,
        directoryPath,
        targetAncestors,
        paths,
      });
      void startTransfer(() => queue.transferFromLocalPaths(request));
    },
  };

  return {
    disabled,
    dropTarget: activeDropTarget,
    dropTargetFolderLocator:
      activeDropTarget?.kind === 'folder' ? activeDropTarget.entry.ref.locator : null,
    dropZoneProps,
    transferConflict,
    uploadFile: () =>
      startTransfer(() =>
        queue.transferFromLocalDialog({
          targetParent: parent,
          targetDirectoryPath: directoryPath,
          kind: 'file',
          targetAncestors,
        }),
      ),
    uploadFolder: () =>
      startTransfer(() =>
        queue.transferFromLocalDialog({
          targetParent: parent,
          targetDirectoryPath: directoryPath,
          kind: 'directory',
          targetAncestors,
        }),
      ),
  };
}

export type DirectoryUpload = ReturnType<typeof useDirectoryUpload>;
