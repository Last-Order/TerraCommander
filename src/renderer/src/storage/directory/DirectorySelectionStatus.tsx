import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { useStore } from 'zustand';
import { formatSize } from '@renderer/format/size';
import { useStorageWorkspace } from '../storage-workspace-context';

export function DirectorySelectionStatus() {
  const { selectionSummary } = useStorageWorkspace();
  const summary = useStore(selectionSummary, (state) => state.summary);
  const { t, i18n } = useTranslation('storage');
  const locale = i18n.resolvedLanguage;
  const sizeFormatter = useMemo(
    () => new Intl.NumberFormat(locale, { maximumFractionDigits: 1 }),
    [locale],
  );

  if (summary === null) return null;

  let text: string;
  if (summary.sizeBytes === undefined) {
    text = t('selectionStatusCount', { count: summary.count });
  } else {
    const size = formatSize(summary.sizeBytes, sizeFormatter);
    text = summary.estimated
      ? t('selectionStatusEstimatedSize', { count: summary.count, size })
      : t('selectionStatusSize', { count: summary.count, size });
  }

  return <span aria-live="polite">{text}</span>;
}
