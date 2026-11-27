import { Copy, Upload } from 'lucide-react';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { useCurrentDirectory } from '../current-directory-context';
import type { DirectoryUpload } from './useDirectoryUpload';
import classes from '../DirectoryListing.module.css';

interface DirectoryUploadDropZoneProps {
  upload: Pick<DirectoryUpload, 'dropActive' | 'dropZoneProps'>;
  children: ReactNode;
}

export function DirectoryUploadDropZone({ upload, children }: DirectoryUploadDropZoneProps) {
  const { t } = useTranslation('storage');
  const { provider } = useCurrentDirectory();
  const isLocal = provider === 'local';

  return (
    <div className={classes.directoryBody} {...upload.dropZoneProps}>
      {upload.dropActive && (
        <div className={classes.dropOverlay} aria-hidden="true">
          <div className={classes.dropPrompt}>
            {isLocal ? (
              <Copy size={16} strokeWidth={1.5} />
            ) : (
              <Upload size={16} strokeWidth={1.5} />
            )}
            <span>{t(isLocal ? 'dropToCopy' : 'dropToUpload')}</span>
          </div>
        </div>
      )}
      {children}
    </div>
  );
}
