import { Copy, Upload } from 'lucide-react';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { useCurrentDirectory } from '../current-directory-context';
import type { DirectoryUpload } from './useDirectoryUpload';
import classes from '../DirectoryListing.module.css';

interface DirectoryUploadDropZoneProps {
  upload: Pick<DirectoryUpload, 'dropTarget' | 'dropZoneProps'>;
  children: ReactNode;
}

export function DirectoryUploadDropZone({ upload, children }: DirectoryUploadDropZoneProps) {
  const { t } = useTranslation('storage');
  const { provider } = useCurrentDirectory();
  const isLocal = provider === 'local';
  const target = upload.dropTarget;

  let prompt: string | null = null;
  if (target?.kind === 'folder') {
    prompt = t(isLocal ? 'dropToCopyIntoFolder' : 'dropToUploadIntoFolder', {
      name: target.name,
    });
  } else if (target !== null) {
    prompt = t(isLocal ? 'dropToCopy' : 'dropToUpload');
  }

  return (
    <div className={classes.directoryBody} {...upload.dropZoneProps}>
      {target !== null && prompt !== null && (
        <div
          className={classes.dropOverlay}
          data-target={target.kind === 'folder' ? 'folder' : undefined}
          aria-hidden="true"
        >
          <div className={classes.dropPrompt}>
            {isLocal ? (
              <Copy size={16} strokeWidth={1.5} />
            ) : (
              <Upload size={16} strokeWidth={1.5} />
            )}
            <span>{prompt}</span>
          </div>
        </div>
      )}
      {children}
    </div>
  );
}
