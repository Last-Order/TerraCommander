import { notifications } from '@mantine/notifications';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { entryKey, type Entry } from '@shared/storage';
import { errorKey, StorageBrowserError } from '../storage-client';
import { useStorageWorkspace } from '../storage-workspace-context';
import { useStorageTaskQueue } from '../tasks/storage-task-queue-context';
import { useCurrentDirectory } from './current-directory-context';
import type { DirectoryPasteConflictModal } from './modals/DirectoryEntryModals';
import { useStorageClipboard, validatePaste } from './storage-clipboard';

const copyEntriesNotification = 'directory-copy-entries';
const pasteStatusNotification = 'directory-paste-status';

interface DirectoryClipboardOptions {
  blocked: boolean;
}

interface PasteConflictState {
  confirmationId: string;
  conflicts?: readonly string[] | undefined;
  clearClipboardOnConfirm: boolean;
  busy: boolean;
}

export function useDirectoryClipboard({ blocked }: DirectoryClipboardOptions) {
  const { t } = useTranslation(['storage', 'errors']);
  const { onAuthRequired } = useStorageWorkspace();
  const queue = useStorageTaskQueue();
  const {
    ref: parent,
    path: directoryPath,
    capabilities: targetCapabilities,
    ancestors: targetAncestors,
  } = useCurrentDirectory();
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
    if (entryKey(clipboard.sourceParent) !== entryKey(parent)) return undefined;
    return new Set(clipboard.entries.map((entry) => entry.ref.locator));
  }, [clipboard, parent]);

  const writeClipboard = (mode: 'copy' | 'cut', entries: readonly Entry[]) => {
    if (entries.length === 0) return;
    setClipboard({
      mode,
      sourceParent: parent,
      sourceDirectoryPath: directoryPath,
      entries,
    });
    const singleKey = mode === 'copy' ? 'copiedEntryNotice' : 'cutEntryNotice';
    const pluralKey = mode === 'copy' ? 'copiedEntriesNotice' : 'cutEntriesNotice';
    notifications.show({
      id: copyEntriesNotification,
      color: 'blue',
      message:
        entries.length === 1
          ? t(singleKey, { name: entries[0]!.name })
          : t(pluralKey, { count: entries.length }),
    });
  };

  const copy = (entries: readonly Entry[]) => writeClipboard('copy', entries);
  const cut = (entries: readonly Entry[]) => writeClipboard('cut', entries);
  const clear = () => setClipboard(null);

  const handlePasteError = (caught: unknown) => {
    if (caught instanceof StorageBrowserError && caught.code === 'AuthRequired') {
      onAuthRequired();
      return;
    }
    notifications.show({
      id: pasteStatusNotification,
      color: 'red',
      message: t(`errors:${errorKey(caught)}`),
    });
  };

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
      handlePasteError(caught);
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
      .catch(handlePasteError)
      .finally(() => setPasteConflict(null));
  };

  const cancelPasteConflict = () => {
    if (!pasteConflict) return;
    const id = pasteConflict.confirmationId;
    setPasteConflict(null);
    void queue.cancelDownloadConfirmation(id).catch(() => {});
  };

  const pasteConflictModal: DirectoryPasteConflictModal | null = pasteConflict
    ? {
        busy: pasteConflict.busy,
        conflicts: pasteConflict.conflicts,
        onConfirm: confirmPasteConflict,
        onCancel: cancelPasteConflict,
      }
    : null;

  return {
    canPaste,
    cutLocators,
    isCutActive,
    pasteConflict: pasteConflictModal,
    copy,
    cut,
    clear,
    paste,
  };
}
