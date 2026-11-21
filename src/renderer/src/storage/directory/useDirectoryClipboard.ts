import { useEffect, useMemo, useRef, useState } from 'react';
import { notifications } from '@mantine/notifications';
import { useTranslation } from 'react-i18next';
import type { Capabilities, Entry, EntryRef } from '@shared/storage';
import { errorKey, StorageBrowserError } from '../storage-client';
import { useStorageTaskQueue } from '../tasks/storage-task-queue-context';
import { directoryKey } from './directory-cache';
import { useStorageClipboard, validatePaste } from './storage-clipboard';

const copyEntriesNotification = 'directory-copy-entries';
const pasteStatusNotification = 'directory-paste-status';

interface DirectoryClipboardOptions {
  parent: EntryRef;
  directoryPath: string;
  targetCapabilities?: Capabilities | undefined;
  targetAncestors: readonly EntryRef[];
  blocked: boolean;
  onAuthRequired: () => void;
}

interface PasteConflictState {
  confirmationId: string;
  conflicts?: readonly string[] | undefined;
  clearClipboardOnConfirm: boolean;
  busy: boolean;
}

export function useDirectoryClipboard({
  parent,
  directoryPath,
  targetCapabilities,
  targetAncestors,
  blocked,
  onAuthRequired,
}: DirectoryClipboardOptions) {
  const { t } = useTranslation(['storage', 'errors']);
  const queue = useStorageTaskQueue();
  const clipboard = useStorageClipboard((state) => state.clipboard);
  const setClipboard = useStorageClipboard((state) => state.setClipboard);
  const [pasteConflict, setPasteConflict] = useState<PasteConflictState | null>(null);
  const pasteConflictIdRef = useRef<string | null>(null);

  useEffect(() => {
    pasteConflictIdRef.current = pasteConflict?.confirmationId ?? null;
  }, [pasteConflict]);

  useEffect(() => {
    return () => {
      const pendingId = pasteConflictIdRef.current;
      if (pendingId !== null) {
        pasteConflictIdRef.current = null;
        void queue.cancelDownloadConfirmation(pendingId).catch(() => {});
      }
    };
  }, [queue]);

  const canPaste = clipboard !== null && clipboard.entries.length > 0 && !blocked;
  const isCutActive = clipboard?.mode === 'cut';

  const cutLocators = useMemo(() => {
    if (!clipboard || clipboard.mode !== 'cut') return undefined;
    if (directoryKey(clipboard.sourceParent) !== directoryKey(parent)) return undefined;
    return new Set(clipboard.entries.map((entry) => entry.ref.locator));
  }, [clipboard, parent]);

  const copy = (entries: readonly Entry[]) => {
    if (entries.length === 0) return;
    setClipboard({
      mode: 'copy',
      sourceParent: parent,
      sourceDirectoryPath: directoryPath,
      entries,
    });
    notifications.show({
      id: copyEntriesNotification,
      color: 'blue',
      message:
        entries.length === 1
          ? t('copiedEntryNotice', { name: entries[0]!.name })
          : t('copiedEntriesNotice', { count: entries.length }),
    });
  };

  const cut = (entries: readonly Entry[]) => {
    if (entries.length === 0) return;
    setClipboard({
      mode: 'cut',
      sourceParent: parent,
      sourceDirectoryPath: directoryPath,
      entries,
    });
    notifications.show({
      id: copyEntriesNotification,
      color: 'blue',
      message:
        entries.length === 1
          ? t('cutEntryNotice', { name: entries[0]!.name })
          : t('cutEntriesNotice', { count: entries.length }),
    });
  };

  const clear = () => setClipboard(null);

  const paste = async () => {
    if (!clipboard || clipboard.entries.length === 0 || blocked) return;

    const validation = validatePaste({
      clipboard,
      targetParent: parent,
      targetAncestors,
      targetCapabilities,
    });
    if (validation.status === 'clear-cut') {
      setClipboard(null);
      return;
    }
    if (validation.status === 'rejected') {
      const notice = {
        crossSource: { color: 'yellow', message: t('crossSourcePasteUnsupported') },
        selfContainment: { color: 'red', message: t('pasteSelfContainmentError') },
        permissionDenied: { color: 'red', message: t('errors:permissionDenied') },
        unsupported: { color: 'red', message: t('errors:unsupported') },
      }[validation.reason];
      notifications.show({ id: pasteStatusNotification, ...notice });
      return;
    }

    try {
      const response = await queue.pasteEntries({
        mode: clipboard.mode,
        sourceParent: clipboard.sourceParent,
        sourceDirectoryPath: clipboard.sourceDirectoryPath,
        entries: clipboard.entries,
        targetParent: parent,
        targetDirectoryPath: directoryPath,
      });
      if (response.status === 'conflict') {
        setPasteConflict({
          confirmationId: response.confirmationId,
          conflicts: response.conflicts,
          clearClipboardOnConfirm: clipboard.mode === 'cut',
          busy: false,
        });
      } else if (clipboard.mode === 'cut') {
        setClipboard(null);
      }
    } catch (caught) {
      if (caught instanceof StorageBrowserError && caught.code === 'AuthRequired') {
        onAuthRequired();
        return;
      }
      notifications.show({
        id: pasteStatusNotification,
        color: 'red',
        message: t(`errors:${errorKey(caught)}`),
      });
    }
  };

  const confirmPasteConflict = () => {
    if (!pasteConflict) return;
    const { confirmationId, clearClipboardOnConfirm } = pasteConflict;
    setPasteConflict((current) => (current ? { ...current, busy: true } : null));
    void queue
      .confirmDownload(confirmationId)
      .then(() => {
        if (clearClipboardOnConfirm) setClipboard(null);
      })
      .catch((caught) => {
        if (caught instanceof StorageBrowserError && caught.code === 'AuthRequired') {
          onAuthRequired();
        } else {
          notifications.show({
            id: pasteStatusNotification,
            color: 'red',
            message: t(`errors:${errorKey(caught)}`),
          });
        }
      })
      .finally(() => setPasteConflict(null));
  };

  const cancelPasteConflict = () => {
    if (!pasteConflict) return;
    const id = pasteConflict.confirmationId;
    setPasteConflict(null);
    void queue.cancelDownloadConfirmation(id).catch(() => {});
  };

  return {
    canPaste,
    cutLocators,
    isCutActive,
    pasteConflict,
    copy,
    cut,
    clear,
    paste,
    confirmPasteConflict,
    cancelPasteConflict,
  };
}
