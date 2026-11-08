import { useCallback, useState } from 'react';
import useSWR from 'swr';
import type { Space } from '../../../shared/storage';
import { localConnectionId } from '../../../shared/storage-browser';
import { DirectoryPane, EmptyDirectoryPane } from './DirectoryPane';
import { StorageSetupModal, type SetupIntent } from './StorageSetupModal';
import { StorageSidebar } from './StorageSidebar';
import { errorText, resultOf } from './storage-client';
import classes from './StorageWorkspace.module.css';

export function StorageWorkspace() {
  const {
    data: connections = [],
    isValidating,
    error,
    mutate,
  } = useSWR('storage/connections', () => resultOf(window.desktop.storage.listConnections()));
  const [dialog, setDialog] = useState<SetupIntent | null>(null);
  const [location, setLocation] = useState<{ space: Space; generation: number } | null>(null);
  const [browseVersion, setBrowseVersion] = useState(0);

  const refresh = useCallback(() => {
    void mutate();
  }, [mutate]);

  return (
    <div className={classes.workspace}>
      <StorageSidebar
        connections={connections}
        activeSpace={location?.space ?? null}
        loading={isValidating}
        error={!isValidating && error ? errorText(error) : null}
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
          version={browseVersion}
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
            if (location?.space.connectionId === id) setBrowseVersion((previous) => previous + 1);
          }}
        />
      )}
    </div>
  );
}
