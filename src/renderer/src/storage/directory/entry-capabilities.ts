import type { Entry } from '@shared/storage';
import { localConnectionId } from '@shared/storage-browser';
import type { PendingEntryEffect } from '../tasks/pending-entry-effects';

export interface EntryCapabilities {
  selectedEntries: Entry[];
  renamableEntry: Entry | undefined;
  canCopy: boolean;
  canCut: boolean;
  canDownload: boolean;
  canRename: boolean;
  canDelete: boolean;
  renamePending: boolean;
  selectionBusy: boolean;
}

export function canDeleteEntry(entry: Entry | undefined): boolean {
  if (entry?.kind !== 'file' && entry?.kind !== 'link' && entry?.kind !== 'directory') {
    return false;
  }
  return entry.capabilities.remove?.support !== 'unsupported';
}

export function resolveEntryCapabilities(
  entries: ReadonlyMap<string, Entry>,
  selectedLocators: ReadonlySet<string>,
  pendingEntries: ReadonlyMap<string, PendingEntryEffect>,
): EntryCapabilities {
  const [selectedLocator] = selectedLocators;
  const selectedEntry =
    selectedLocators.size === 1 && selectedLocator !== undefined
      ? entries.get(selectedLocator)
      : undefined;
  const renamableEntry =
    selectedEntry?.capabilities.rename?.support !== 'unsupported' ? selectedEntry : undefined;
  const renamePending =
    renamableEntry !== undefined && pendingEntries.get(renamableEntry.ref.locator)?.busy === true;

  const selectedEntries = [...selectedLocators].flatMap((locator) => {
    const entry = entries.get(locator);
    return entry ? [entry] : [];
  });
  const selectionBusy = selectedEntries.some(
    (entry) => pendingEntries.get(entry.ref.locator)?.busy === true,
  );

  const canDelete =
    selectedEntries.length > 0 && selectedEntries.every((entry) => canDeleteEntry(entry));
  const canDownload =
    selectedEntries.length > 0 &&
    selectedEntries.every(
      (entry) =>
        entry.ref.connectionId !== localConnectionId &&
        (entry.kind === 'file'
          ? entry.capabilities.read?.support !== 'unsupported'
          : entry.kind === 'directory' && entry.capabilities.list?.support !== 'unsupported'),
    );
  const canCopy =
    selectedEntries.length > 0 &&
    selectedEntries.every((entry) => entry.kind === 'file' || entry.kind === 'directory');
  const canCut =
    selectedEntries.length > 0 &&
    selectedEntries.every(
      (entry) =>
        (entry.kind === 'file' || entry.kind === 'directory' || entry.kind === 'link') &&
        (entry.capabilities.moveWithin?.support !== 'unsupported' || canDeleteEntry(entry)),
    );

  return {
    selectedEntries,
    renamableEntry,
    canCopy,
    canCut,
    canDownload,
    canRename: renamableEntry !== undefined,
    canDelete,
    renamePending,
    selectionBusy,
  };
}
