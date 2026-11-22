import type { ReactNode } from 'react';
import { Upload } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import classes from './DirectoryListing.module.css';
import type { DirectoryUpload } from './useDirectoryUpload';

interface DirectoryDropZoneProps {
  upload: Pick<DirectoryUpload, 'error' | 'dropActive' | 'dropZoneProps'>;
  children: ReactNode;
}

export function DirectoryDropZone({ upload, children }: DirectoryDropZoneProps) {
  const { t } = useTranslation(['storage', 'errors']);

  return (
    <>
      {upload.error && (
        <p className={classes.directoryStatus} role="alert">
          {t(`errors:${upload.error}`)}
        </p>
      )}
      <div className={classes.directoryBody} {...upload.dropZoneProps}>
        {upload.dropActive && (
          <div className={classes.dropOverlay} aria-hidden="true">
            <div className={classes.dropPrompt}>
              <Upload size={16} strokeWidth={1.5} />
              <span>{t('dropToUpload')}</span>
            </div>
          </div>
        )}
        {children}
      </div>
    </>
  );
}
