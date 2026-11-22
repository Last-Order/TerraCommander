import { useLayoutEffect } from 'react';
import { ActionIcon, TextInput, Transition } from '@mantine/core';
import { useReducedMotion } from '@mantine/hooks';
import { ChevronDown, ChevronUp, Search, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import listingClasses from './DirectoryListing.module.css';
import classes from './DirectorySearch.module.css';
import type { DirectorySearchController } from './useDirectorySearch';

interface DirectorySearchProps {
  search: Pick<
    DirectorySearchController,
    'opened' | 'inputRef' | 'query' | 'index' | 'total' | 'changeQuery' | 'navigate'
  >;
  onClose: () => void;
}

export function DirectorySearch({ search, onClose }: DirectorySearchProps) {
  const { t } = useTranslation('storage');
  const reduceMotion = useReducedMotion();
  const { opened, inputRef, query, index, total, changeQuery, navigate } = search;

  useLayoutEffect(() => {
    if (opened) inputRef.current?.focus();
  }, [inputRef, opened]);

  return (
    <Transition
      mounted={opened}
      duration={reduceMotion ? 0 : 160}
      exitDuration={reduceMotion ? 0 : 120}
      timingFunction="ease-out"
      transition={{
        in: { opacity: 1, transform: 'translateY(0)' },
        out: { opacity: 0, transform: 'translateY(-4px)' },
        transitionProperty: 'opacity, transform',
      }}
    >
      {(styles) => (
        <div
          className={listingClasses.searchOverlay}
          data-directory-search
          style={styles}
          inert={!opened}
          aria-hidden={!opened || undefined}
        >
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
              onChange={(event) => changeQuery(event.currentTarget.value)}
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
                navigate(event.shiftKey ? -1 : 1);
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
                    navigate(direction);
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
        </div>
      )}
    </Transition>
  );
}
