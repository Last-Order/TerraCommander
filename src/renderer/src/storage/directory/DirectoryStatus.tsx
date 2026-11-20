import { Button } from '@mantine/core';
import { CircleAlert, RefreshCw } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { StorageErrorKey } from '../storage-client';
import classes from './DirectoryListing.module.css';

interface DirectoryStatusProps {
  error: StorageErrorKey | null;
  empty: boolean;
  onReauthorize: () => void;
  onRetry: () => void;
}

export function DirectoryStatus({ error, empty, onReauthorize, onRetry }: DirectoryStatusProps) {
  const { t } = useTranslation(['storage', 'common', 'errors']);

  return (
    <>
      {error && (
        <div className={classes.directoryError} role="alert">
          <CircleAlert size={24} strokeWidth={1.5} aria-hidden="true" />
          <p>{t(`errors:${error}`)}</p>
          <Button
            variant="subtle"
            size="compact-sm"
            leftSection={<RefreshCw size={16} strokeWidth={1.5} aria-hidden="true" />}
            aria-haspopup={error === 'AuthRequired' ? 'dialog' : undefined}
            onClick={error === 'AuthRequired' ? onReauthorize : onRetry}
          >
            {error === 'AuthRequired' ? t('reauthorize') : t('common:retry')}
          </Button>
        </div>
      )}
      {!error && empty && <p className={classes.emptyDirectory}>{t('emptyDirectory')}</p>}
    </>
  );
}
