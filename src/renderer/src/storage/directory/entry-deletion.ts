import type { Entry } from '@shared/storage';

export function canDeleteEntry(entry: Entry | undefined): boolean {
  if (entry?.kind !== 'file' && entry?.kind !== 'link' && entry?.kind !== 'directory') {
    return false;
  }
  return entry.capabilities.remove?.support !== 'unsupported';
}
