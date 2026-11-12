import { useLayoutEffect, type RefObject } from 'react';
import { ActionIcon, TextInput } from '@mantine/core';
import { ChevronDown, ChevronUp, Search, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import classes from './DirectorySearch.module.css';

interface DirectorySearchProps {
  inputRef: RefObject<HTMLInputElement | null>;
  query: string;
  index: number;
  total: number;
  onChange: (query: string) => void;
  onNavigate: (direction: -1 | 1) => void;
  onClose: () => void;
}

export function DirectorySearch({
  inputRef,
  query,
  index,
  total,
  onChange,
  onNavigate,
  onClose,
}: DirectorySearchProps) {
  const { t } = useTranslation('storage');

  useLayoutEffect(() => {
    inputRef.current?.focus();
  }, [inputRef]);

  return (
    <div className={classes.search}>
      <TextInput
        ref={inputRef}
        type="search"
        className={classes.input}
        size="sm"
        aria-label={t('searchDirectory')}
        aria-keyshortcuts="Control+f"
        placeholder={t('searchPlaceholder')}
        leftSection={<Search size={16} strokeWidth={1.5} aria-hidden="true" />}
        leftSectionPointerEvents="none"
        value={query}
        onChange={(event) => onChange(event.currentTarget.value)}
        onKeyDown={(event) => {
          if (
            event.key !== 'Enter' ||
            event.nativeEvent.isComposing ||
            event.altKey ||
            event.ctrlKey ||
            event.metaKey
          )
            return;
          event.preventDefault();
          onNavigate(event.shiftKey ? -1 : 1);
        }}
      />
      {query && (
        <output
          className={classes.position}
          aria-label={
            total === 0
              ? t('noSearchResults')
              : t('searchMatchPosition', { current: index + 1, total })
          }
          title={total === 0 ? t('noSearchResults') : undefined}
        >
          {total === 0 ? t('noSearchResults') : `${index + 1} / ${total}`}
        </output>
      )}
      {query &&
        total > 0 &&
        (
          [
            {
              direction: -1,
              label: 'previousSearchMatch',
              shortcut: 'Shift+Enter',
              Icon: ChevronUp,
            },
            { direction: 1, label: 'nextSearchMatch', shortcut: 'Enter', Icon: ChevronDown },
          ] as const
        ).map(({ direction, label, shortcut, Icon }) => (
          <ActionIcon
            key={direction}
            size="sm"
            variant="subtle"
            color="gray"
            aria-label={t(label)}
            aria-keyshortcuts={shortcut}
            title={`${t(label)} (${shortcut})`}
            onClick={() => {
              onNavigate(direction);
              inputRef.current?.focus();
            }}
          >
            <Icon size={16} strokeWidth={1.5} aria-hidden="true" />
          </ActionIcon>
        ))}
      <ActionIcon
        size="sm"
        variant="subtle"
        color="gray"
        aria-label={t('closeSearch')}
        aria-keyshortcuts="Escape"
        title={`${t('closeSearch')} (Esc)`}
        onClick={onClose}
      >
        <X size={16} strokeWidth={1.5} aria-hidden="true" />
      </ActionIcon>
    </div>
  );
}
