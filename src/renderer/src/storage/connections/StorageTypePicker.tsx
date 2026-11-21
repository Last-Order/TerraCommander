import type { LucideIcon } from 'lucide-react';
import { Cloud, HardDrive } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import classes from './StorageTypePicker.module.css';

export type StorageTypeId = 'local' | 'google-drive';

type StorageCategory = 'local' | 'cloud';
type CategoryTitleKey = 'storageCategoryLocal' | 'storageCategoryCloud';
type TypeNameKey = 'localFileSystem';
type TypeDescriptionKey = 'localFileSystemDescription' | 'googleDriveDescription';

interface StorageTypeOption {
  id: StorageTypeId;
  category: StorageCategory;
  icon: LucideIcon;
  /** Translation key, or a literal for brand names. */
  name: { key: TypeNameKey } | { literal: string };
  descriptionKey: TypeDescriptionKey;
}

// New storage types are added here; categories render only when they have options.
const categories: readonly { id: StorageCategory; titleKey: CategoryTitleKey }[] = [
  { id: 'local', titleKey: 'storageCategoryLocal' },
  { id: 'cloud', titleKey: 'storageCategoryCloud' },
];

const options: readonly StorageTypeOption[] = [
  {
    id: 'local',
    category: 'local',
    icon: HardDrive,
    name: { key: 'localFileSystem' },
    descriptionKey: 'localFileSystemDescription',
  },
  {
    id: 'google-drive',
    category: 'cloud',
    icon: Cloud,
    name: { literal: 'Google Drive' },
    descriptionKey: 'googleDriveDescription',
  },
];

interface StorageTypePickerProps {
  onSelect: (type: StorageTypeId) => void;
}

export function StorageTypePicker({ onSelect }: StorageTypePickerProps) {
  const { t } = useTranslation('storage');

  return (
    <div className={classes.picker}>
      {categories.map((category) => {
        const items = options.filter((option) => option.category === category.id);
        if (items.length === 0) return null;
        const titleId = `storage-type-category-${category.id}`;
        return (
          <section key={category.id} className={classes.category} aria-labelledby={titleId}>
            <h3 id={titleId} className={classes.categoryTitle}>
              {t(category.titleKey)}
            </h3>
            <ul className={classes.options}>
              {items.map((option) => {
                const Icon = option.icon;
                const name = 'key' in option.name ? t(option.name.key) : option.name.literal;
                return (
                  <li key={option.id}>
                    <button
                      type="button"
                      className={classes.option}
                      onClick={() => onSelect(option.id)}
                    >
                      <span className={classes.icon} aria-hidden="true">
                        <Icon size={18} strokeWidth={1.75} />
                      </span>
                      <span className={classes.text}>
                        <span className={classes.name}>{name}</span>
                        <span className={classes.description}>{t(option.descriptionKey)}</span>
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          </section>
        );
      })}
    </div>
  );
}
