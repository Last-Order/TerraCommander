import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import useSWR from 'swr';
import type { Space } from '@shared/storage';
import { localConnectionId } from '@shared/storage-browser';
import type { TaskMessage } from '@shared/tasks';
import { TaskQueueDock } from '../tasks/TaskQueueDock';
import { StorageSetupModal, type SetupIntent } from './connections/StorageSetupModal';
import { StorageSidebar } from './connections/StorageSidebar';
import { DirectoryCache } from './directory/directory-cache';
import { DirectoryPane, EmptyDirectoryPane } from './directory/DirectoryPane';
import { errorKey, resultOf } from './storage-client';
import classes from './StorageWorkspace.module.css';
import { StorageTaskClient } from './tasks/storage-task-client';
import { presentStorageTask, presentStorageTaskGroup } from './tasks/storage-task-presenter';
import { StorageTaskQueueContext } from './tasks/storage-task-queue-context';

export function StorageWorkspace({ onOpenSettings }: { onOpenSettings: () => void }) {
  const { t, i18n } = useTranslation('errors');
  const {
    data: connections = [],
    isValidating,
    error,
    mutate,
  } = useSWR('storage/connections', () => resultOf(window.desktop.storage.listConnections()));
  const [dialog, setDialog] = useState<SetupIntent | null>(null);
  const [location, setLocation] = useState<{ space: Space; generation: number } | null>(null);
  const [directoryCache] = useState(() => new DirectoryCache());

  const refresh = useCallback(() => {
    void mutate();
  }, [mutate]);
  const [queue] = useState(
    () => new StorageTaskClient({ directoryCache, onAuthRequired: refresh }),
  );
  useEffect(() => queue.connect(), [queue]);

  const translateTaskMessage = useCallback(
    (message: TaskMessage) => {
      const value: unknown = i18n.t(
        message.key as never,
        (message.values ? { ...message.values } : undefined) as never,
      );
      return typeof value === 'string' ? value : '';
    },
    [i18n],
  );

  return (
    <StorageTaskQueueContext.Provider value={queue}>
      <div className={classes.workspace}>
        <StorageSidebar
          connections={connections}
          activeSpace={location?.space ?? null}
          loading={isValidating}
          error={!isValidating && error ? t(errorKey(error)) : null}
          onOpenSettings={onOpenSettings}
          onRetry={refresh}
          onAdd={() => setDialog({ kind: 'add' })}
          onManage={(connection) => setDialog({ kind: 'manage', connection })}
          onReauthorize={(connection) => setDialog({ kind: 'reauthorize', connection })}
          onOpen={(space) =>
            setLocation((previous) => ({ space, generation: (previous?.generation ?? 0) + 1 }))
          }
        />
        <TaskQueueDock
          queue={queue}
          presentTask={presentStorageTask}
          presentGroup={presentStorageTaskGroup}
          translateMessage={translateTaskMessage}
        >
          {location ? (
            <DirectoryPane
              key={location.generation}
              space={location.space}
              cache={directoryCache}
              onAuthRequired={refresh}
            />
          ) : (
            <EmptyDirectoryPane />
          )}
        </TaskQueueDock>
        {dialog && (
          <StorageSetupModal
            intent={dialog}
            localConnection={connections.find(({ id }) => id === localConnectionId)}
            onClose={() => setDialog(null)}
            onChanged={refresh}
            onAuthorized={(id) => {
              refresh();
              directoryCache.invalidateConnection(id);
            }}
          />
        )}
      </div>
    </StorageTaskQueueContext.Provider>
  );
}
