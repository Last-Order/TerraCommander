import type { Entry } from '@shared/storage';
import type { StorageProvider } from '@shared/storage-browser';

export interface EntryCapabilities {
  canCopy: boolean;
  canCut: boolean;
  canDownload: boolean;
  canRename: boolean;
  canDelete: boolean;
}

function canDeleteEntry(entry: Entry): boolean {
  return (
    (entry.kind === 'file' || entry.kind === 'link' || entry.kind === 'directory') &&
    entry.capabilities.remove?.support !== 'unsupported'
  );
}

function canDownloadEntry(entry: Entry, provider?: StorageProvider): boolean {
  if (provider === 'local') return false;
  if (entry.kind === 'file') return entry.capabilities.read?.support !== 'unsupported';
  return entry.kind === 'directory' && entry.capabilities.list?.support !== 'unsupported';
}

function canCopyEntry(entry: Entry): boolean {
  return entry.kind === 'file' || entry.kind === 'directory';
}

function canCutEntry(entry: Entry): boolean {
  return (
    (entry.kind === 'file' || entry.kind === 'directory' || entry.kind === 'link') &&
    (entry.capabilities.moveWithin?.support !== 'unsupported' || canDeleteEntry(entry))
  );
}

export function resolveEntryCapabilities(
  selectedEntries: readonly Entry[],
  provider?: StorageProvider,
): EntryCapabilities {
  if (selectedEntries.length === 0) {
    return {
      canCopy: false,
      canCut: false,
      canDownload: false,
      canRename: false,
      canDelete: false,
    };
  }

  let canDelete = true;
  let canDownload = true;
  let canCopy = true;
  let canCut = true;

  for (const entry of selectedEntries) {
    if (canDelete && !canDeleteEntry(entry)) canDelete = false;
    if (canDownload && !canDownloadEntry(entry, provider)) canDownload = false;
    if (canCopy && !canCopyEntry(entry)) canCopy = false;
    if (canCut && !canCutEntry(entry)) canCut = false;
    if (!canDelete && !canDownload && !canCopy && !canCut) break;
  }

  const singleEntry = selectedEntries.length === 1 ? selectedEntries[0] : undefined;
  return {
    canCopy,
    canCut,
    canDownload,
    canRename:
      singleEntry !== undefined && singleEntry.capabilities.rename?.support !== 'unsupported',
    canDelete,
  };
}
