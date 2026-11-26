import { notifications } from '@mantine/notifications';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import useSWR from 'swr';
import type { Space } from '@shared/storage';
import type { TaskMessage } from '@shared/tasks';
import { TaskQueueDock } from '../tasks/TaskQueueDock';
import { StorageSetupModal, type SetupIntent } from './connections/StorageSetupModal';
import { StorageSidebar } from './connections/StorageSidebar';
import { DirectoryPane, EmptyDirectoryPane } from './directory/DirectoryPane';
import { DirectorySelectionStatus } from './directory/DirectorySelectionStatus';
import { DirectoryCache } from './directory/state/directory-cache';
import { DirectoryEffectsStore } from './directory/state/directory-effects';
import { createSelectionSummaryStore } from './directory/state/selection-summary';
import { errorKey, resultOf } from './storage-client';
import { StorageWorkspaceContext } from './storage-workspace-context';
import { StorageTaskClient } from './tasks/storage-task-client';
import { presentStorageTask, presentStorageTaskGroup } from './tasks/storage-task-presenter';
import { StorageTaskQueueContext } from './tasks/storage-task-queue-context';
import classes from './StorageWorkspace.module.css';

const connectionsErrorNotification = 'storage-connections-error';

export function StorageWorkspace({ onOpenSettings }: { onOpenSettings: () => void }) {
  const { t, i18n } = useTranslation('errors');
  const hasConnections = useRef(false);
  const { data, isLoading, isValidating, error, mutate } = useSWR(
    'storage/connections',
    () => resultOf(window.desktop.storage.listConnections()),
    {
      onError: (failure) => {
        if (hasConnections.current) {
          notifications.show({
            id: connectionsErrorNotification,
            color: 'red',
            message: t(errorKey(failure)),
          });
        }
      },
    },
  );
  const connections = data ?? [];
  useEffect(() => {
    hasConnections.current = connections.length > 0;
  }, [connections.length]);
  const [dialog, setDialog] = useState<SetupIntent | null>(null);
  const [location, setLocation] = useState<{ space: Space; generation: number } | null>(null);
  const [directoryCache] = useState(() => new DirectoryCache());
  const [directoryEffects] = useState(() => new DirectoryEffectsStore());
  const [selectionSummary] = useState(() => createSelectionSummaryStore());

  const refresh = useCallback(() => {
    void mutate();
  }, [mutate]);
  const reauthorize = useCallback(
    (connectionId: string) => {
      const connection = data?.find(({ id }) => id === connectionId);
      if (connection) setDialog({ kind: 'reauthorize', connection });
    },
    [data],
  );
  const workspace = useMemo(
    () => ({
      directoryCache,
      directoryEffects,
      selectionSummary,
      onAuthRequired: refresh,
      reauthorize,
    }),
    [directoryCache, directoryEffects, selectionSummary, refresh, reauthorize],
  );
  const [queue] = useState(
    () => new StorageTaskClient({ directoryCache, directoryEffects, onAuthRequired: refresh }),
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
    <StorageWorkspaceContext.Provider value={workspace}>
      <StorageTaskQueueContext.Provider value={queue}>
        <div className={classes.workspace}>
          <StorageSidebar
            connections={connections}
            activeSpace={location?.space ?? null}
            loading={isLoading}
            error={!isValidating && error && connections.length === 0 ? t(errorKey(error)) : null}
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
            status={<DirectorySelectionStatus />}
          >
            {location ? (
              <DirectoryPane key={location.generation} space={location.space} />
            ) : (
              <EmptyDirectoryPane />
            )}
          </TaskQueueDock>
          {dialog && (
            <StorageSetupModal
              intent={dialog}
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
    </StorageWorkspaceContext.Provider>
  );
}
