import { notifications } from '@mantine/notifications';
import { useEffect, useRef, useState, type DragEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { errorKey } from '@renderer/storage/storage-client';
import { useStorageWorkspace } from '@renderer/storage/storage-workspace-context';
import { useStorageTaskQueue } from '@renderer/storage/tasks/storage-task-queue-context';
import type { PasteEntriesResponse } from '@shared/tasks';
import { useCurrentDirectory } from '../current-directory-context';
import type { DirectoryTransferConflictModal } from '../modals/DirectoryEntryModals';

const uploadErrorNotification = 'directory-upload-error';

interface DirectoryUploadOptions {
  blocked: boolean;
}

interface UploadConflictState {
  confirmationId: string;
  conflicts?: readonly string[] | undefined;
  busy: boolean;
}

function hasDroppedFiles(dataTransfer: DataTransfer | null) {
  return Array.from(dataTransfer?.types ?? []).includes('Files');
}

export function useDirectoryUpload({ blocked }: DirectoryUploadOptions) {
  const { t } = useTranslation(['storage', 'errors']);
  const { onAuthRequired } = useStorageWorkspace();
  const queue = useStorageTaskQueue();
  const {
    ref: parent,
    provider,
    path: directoryPath,
    ancestors: targetAncestors,
    canDropLocalFiles,
  } = useCurrentDirectory();
  const [pending, setPending] = useState(false);
  const [dragActive, setDragActive] = useState(false);
  const [conflict, setConflict] = useState<UploadConflictState | null>(null);
  const conflictIdRef = useRef<string | null>(null);
  const disabled = blocked || pending;
  const canDrop = canDropLocalFiles && !disabled;

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

  const dropZoneProps = {
    onDragEnter: (event: DragEvent<HTMLElement>) => {
      if (!canDrop || !hasDroppedFiles(event.dataTransfer)) return;
      event.preventDefault();
      setDragActive(true);
    },
    onDragOver: (event: DragEvent<HTMLElement>) => {
      if (!hasDroppedFiles(event.dataTransfer)) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = canDrop ? 'copy' : 'none';
      if (canDrop !== dragActive) setDragActive(canDrop);
    },
    onDragLeave: (event: DragEvent<HTMLElement>) => {
      const { currentTarget, relatedTarget } = event;
      if (!(relatedTarget instanceof Node && currentTarget.contains(relatedTarget))) {
        setDragActive(false);
      }
    },
    onDrop: (event: DragEvent<HTMLElement>) => {
      if (!hasDroppedFiles(event.dataTransfer)) return;
      event.preventDefault();
      event.stopPropagation();
      setDragActive(false);
      if (!canDrop) return;
      const paths = Array.from(event.dataTransfer.files)
        .map((file) => queue.getPathForFile(file))
        .filter((path) => path.length > 0);
      if (paths.length === 0) return;
      void startTransfer(() =>
        queue.transferFromLocalPaths({
          targetParent: parent,
          targetDirectoryPath: directoryPath,
          paths,
          targetAncestors,
        }),
      );
    },
  };

  return {
    disabled,
    dropActive: dragActive && canDrop,
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
