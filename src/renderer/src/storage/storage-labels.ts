import type { TFunction } from 'i18next';
import type { StorageLabel } from '../../../shared/storage';

export function formatStorageLabel(label: StorageLabel, t: TFunction<'storage'>): string {
  return typeof label === 'string' ? label : t(label.messageKey);
}
