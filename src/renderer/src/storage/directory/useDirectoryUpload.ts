import { useState, type DragEvent } from 'react';
import type { EntryRef } from '@shared/storage';
import { errorKey, type StorageErrorKey } from '../storage-client';
import { useStorageTaskQueue } from '../tasks/storage-task-queue-context';

interface DirectoryUploadOptions {
  parent: EntryRef;
  directoryPath: string;
  canUpload: boolean;
  blocked: boolean;
  onAuthRequired: () => void;
}

function hasDroppedFiles(dataTransfer: DataTransfer | null) {
  return Array.from(dataTransfer?.types ?? []).includes('Files');
}

export function useDirectoryUpload({
  parent,
  directoryPath,
  canUpload,
  blocked,
  onAuthRequired,
}: DirectoryUploadOptions) {
  const queue = useStorageTaskQueue();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<StorageErrorKey | null>(null);
  const [dragActive, setDragActive] = useState(false);
  const disabled = blocked || pending;
  const canDrop = canUpload && !disabled;

  const startUpload = async (upload: () => Promise<void>) => {
    setPending(true);
    setError(null);
    try {
      await upload();
    } catch (failure) {
      const code = errorKey(failure);
      if (code !== 'Cancelled') setError(code);
      if (code === 'AuthRequired') onAuthRequired();
    } finally {
      setPending(false);
    }
  };

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
      void startUpload(() => queue.uploadPaths({ parent, directoryPath, paths }));
    },
  };

  return {
    disabled,
    error,
    dropActive: dragActive && canDrop,
    dropZoneProps,
    uploadFile: () => startUpload(() => queue.uploadFile({ parent, directoryPath })),
    uploadFolder: () => startUpload(() => queue.uploadFolder({ parent, directoryPath })),
  };
}
