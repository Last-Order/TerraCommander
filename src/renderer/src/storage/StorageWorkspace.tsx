import { useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';
import useSWR from 'swr';
import type { Space } from '../../../shared/storage';
import { localConnectionId } from '../../../shared/storage-browser';
import { DirectoryPane, EmptyDirectoryPane } from './DirectoryPane';
import { StorageSetupModal, type SetupIntent } from './StorageSetupModal';
import { StorageSidebar } from './StorageSidebar';
import { DirectoryCache } from './directory-cache';
import { errorKey, resultOf } from './storage-client';
import classes from './StorageWorkspace.module.css';

export function StorageWorkspace({ onOpenSettings }: { onOpenSettings: () => void }) {
  const { t } = useTranslation('errors');
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

  return (
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
  );
}
