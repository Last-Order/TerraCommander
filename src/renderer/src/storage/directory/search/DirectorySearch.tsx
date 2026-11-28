import { ActionIcon, TextInput, Transition, type MantineTransition } from '@mantine/core';
import { useReducedMotion } from '@mantine/hooks';
import type { TFunction } from 'i18next';
import { ChevronDown, ChevronUp, ListChecks, Search, X, type LucideIcon } from 'lucide-react';
import { useCallback, type KeyboardEvent } from 'react';
import { useTranslation } from 'react-i18next';
import type { DirectorySearchController } from './useDirectorySearch';
import listingClasses from '../DirectoryListing.module.css';
import classes from './DirectorySearch.module.css';

const searchTransition: MantineTransition = {
  in: { opacity: 1, transform: 'translateY(0)' },
  out: { opacity: 0, transform: 'translateY(-4px)' },
  transitionProperty: 'opacity, transform',
};

const navigationActions = [
  {
    direction: -1,
    labelKey: 'previousSearchMatch',
    shortcut: 'Shift+Enter',
    icon: ChevronUp,
  },
  {
    direction: 1,
    labelKey: 'nextSearchMatch',
    shortcut: 'Enter',
    icon: ChevronDown,
  },
] as const;

const iconSize = 14;
const actionButtonSize = 24;

interface MatchStatus {
  text: string;
  ariaLabel?: string | undefined;
  title?: string | undefined;
  empty: boolean;
}

function getMatchStatus(
  query: string,
  index: number,
  total: number,
  t: TFunction<'storage'>,
): MatchStatus {
  if (query.length === 0) {
    return { text: '', empty: false };
  }
  if (total === 0) {
    const label = t('noSearchResults');
    return { text: label, ariaLabel: label, title: label, empty: true };
  }
  const current = Math.max(index, 0) + 1;
  return {
    text: `${current}/${total}`,
    ariaLabel: t('searchMatchPosition', { current, total }),
    empty: false,
  };
}

function isMatchNavigationEvent(event: KeyboardEvent<HTMLInputElement>): boolean {
  return (
    event.key === 'Enter' &&
    !event.nativeEvent.isComposing &&
    !event.altKey &&
    !event.ctrlKey &&
    !event.metaKey
  );
}

interface SearchActionButtonProps {
  label: string;
  shortcut?: string;
  shortcutHint?: string;
  disabled?: boolean;
  icon: LucideIcon;
  onClick: () => void;
}

function SearchActionButton({
  label,
  shortcut,
  shortcutHint = shortcut,
  disabled = false,
  icon: Icon,
  onClick,
}: SearchActionButtonProps) {
  return (
    <ActionIcon
      size={actionButtonSize}
      variant="subtle"
      color="gray"
      disabled={disabled}
      aria-label={label}
      aria-keyshortcuts={shortcut}
      title={shortcutHint ? `${label} (${shortcutHint})` : label}
      onClick={onClick}
    >
      <Icon size={iconSize} strokeWidth={1.5} aria-hidden="true" />
    </ActionIcon>
  );
}

interface DirectorySearchProps {
  search: Pick<
    DirectorySearchController,
    'opened' | 'inputRef' | 'query' | 'index' | 'total' | 'changeQuery' | 'navigate' | 'selectAll'
  >;
  onClose: () => void;
}

export function DirectorySearch({ search, onClose }: DirectorySearchProps) {
  const { t } = useTranslation('storage');
  const reduceMotion = useReducedMotion();
  const { opened, inputRef, query, index, total, changeQuery, navigate, selectAll } = search;

  const hasMatches = query.length > 0 && total > 0;
  const status = getMatchStatus(query, index, total, t);

  const assignInputRef = useCallback(
    (node: HTMLInputElement | null) => {
      inputRef.current = node;
      if (node && opened) node.focus({ preventScroll: true });
    },
    [inputRef, opened],
  );

  const handleInputKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (!isMatchNavigationEvent(event)) return;
    event.preventDefault();
    navigate(event.shiftKey ? -1 : 1);
  };

  const handleNavigate = (direction: -1 | 1) => {
    navigate(direction);
    inputRef.current?.focus({ preventScroll: true });
  };

  return (
    <Transition
      mounted={opened}
      duration={reduceMotion ? 0 : 160}
      exitDuration={reduceMotion ? 0 : 120}
      timingFunction="ease-out"
      transition={searchTransition}
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
              ref={assignInputRef}
              type="search"
              variant="unstyled"
              size="xs"
              className={classes.input}
              aria-label={t('searchDirectory')}
              aria-keyshortcuts="Control+f"
              placeholder={t('searchPlaceholder')}
              leftSection={<Search size={iconSize} strokeWidth={1.5} aria-hidden="true" />}
              leftSectionWidth={actionButtonSize}
              leftSectionPointerEvents="none"
              value={query}
              onChange={(event) => changeQuery(event.currentTarget.value)}
              onKeyDown={handleInputKeyDown}
            />
            <output
              className={classes.position}
              data-empty={status.empty || undefined}
              aria-label={status.ariaLabel}
              title={status.title}
            >
              {status.text}
            </output>
            <span className={classes.divider} aria-hidden="true" />
            <div className={classes.actions}>
              <SearchActionButton
                label={t('selectAllSearchMatches')}
                disabled={!hasMatches}
                icon={ListChecks}
                onClick={selectAll}
              />
              {navigationActions.map(({ direction, labelKey, shortcut, icon }) => (
                <SearchActionButton
                  key={direction}
                  label={t(labelKey)}
                  shortcut={shortcut}
                  disabled={!hasMatches}
                  icon={icon}
                  onClick={() => handleNavigate(direction)}
                />
              ))}
              <SearchActionButton
                label={t('closeSearch')}
                shortcut="Escape"
                shortcutHint="Esc"
                icon={X}
                onClick={onClose}
              />
            </div>
          </div>
        </div>
      )}
    </Transition>
  );
}
