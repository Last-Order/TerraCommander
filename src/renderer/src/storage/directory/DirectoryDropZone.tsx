import { Upload } from 'lucide-react';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import type { DirectoryUpload } from './useDirectoryUpload';
import classes from './DirectoryListing.module.css';

interface DirectoryDropZoneProps {
  upload: Pick<DirectoryUpload, 'dropActive' | 'dropZoneProps'>;
  children: ReactNode;
}

export function DirectoryDropZone({ upload, children }: DirectoryDropZoneProps) {
  const { t } = useTranslation('storage');

  return (
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
  );
}
