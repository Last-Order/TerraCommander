import { notifications } from '@mantine/notifications';
import { useState, type DragEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { errorKey } from '@renderer/storage/storage-client';
import { useStorageWorkspace } from '@renderer/storage/storage-workspace-context';
import { useStorageTaskQueue } from '@renderer/storage/tasks/storage-task-queue-context';
import { useCurrentDirectory } from '../current-directory-context';

const uploadErrorNotification = 'directory-upload-error';

interface DirectoryUploadOptions {
  blocked: boolean;
}

function hasDroppedFiles(dataTransfer: DataTransfer | null) {
  return Array.from(dataTransfer?.types ?? []).includes('Files');
}

export function useDirectoryUpload({ blocked }: DirectoryUploadOptions) {
  const { t } = useTranslation('errors');
  const { onAuthRequired } = useStorageWorkspace();
  const queue = useStorageTaskQueue();
  const { ref: parent, path: directoryPath, canUpload } = useCurrentDirectory();
  const [pending, setPending] = useState(false);
  const [dragActive, setDragActive] = useState(false);
  const disabled = blocked || pending;
  const canDrop = canUpload && !disabled;

  const startUpload = async (upload: () => Promise<void>) => {
    setPending(true);
    try {
      await upload();
    } catch (failure) {
      const code = errorKey(failure);
      if (code !== 'cancelled') {
        notifications.show({
          id: uploadErrorNotification,
          color: 'red',
          message: t(code),
        });
      }
      if (code === 'authRequired') onAuthRequired();
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
    dropActive: dragActive && canDrop,
    dropZoneProps,
    uploadFile: () => startUpload(() => queue.uploadFile({ parent, directoryPath })),
    uploadFolder: () => startUpload(() => queue.uploadFolder({ parent, directoryPath })),
  };
}

export type DirectoryUpload = ReturnType<typeof useDirectoryUpload>;
