import { ActionIcon, TextInput, Transition, type MantineTransition } from '@mantine/core';
import { useReducedMotion } from '@mantine/hooks';
import type { TFunction } from 'i18next';
import {
  CaseSensitive,
  ChevronDown,
  ChevronUp,
  ListChecks,
  Regex,
  Search,
  X,
  type LucideIcon,
} from 'lucide-react';
import { useCallback, type KeyboardEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { useKeyboardShortcuts } from '@renderer/shortcuts/useKeyboardShortcuts';
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
const toggleIconSize = 15;
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
  invalidPattern: boolean,
  t: TFunction<'storage'>,
): MatchStatus {
  if (query.length === 0) {
    return { text: '', empty: false };
  }
  if (invalidPattern) {
    const label = t('invalidSearchPattern');
    return { text: label, ariaLabel: label, title: label, empty: true };
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
  pressed?: boolean;
  className?: string | undefined;
  icon: LucideIcon;
  iconSize?: number;
  onClick: () => void;
}

function SearchActionButton({
  label,
  shortcut,
  shortcutHint = shortcut,
  disabled = false,
  pressed,
  className,
  icon: Icon,
  iconSize: size = iconSize,
  onClick,
}: SearchActionButtonProps) {
  return (
    <ActionIcon
      size={actionButtonSize}
      variant="subtle"
      color="gray"
      className={className}
      disabled={disabled}
      aria-pressed={pressed}
      aria-label={label}
      aria-keyshortcuts={shortcut}
      title={shortcutHint ? `${label} (${shortcutHint})` : label}
      onClick={onClick}
    >
      <Icon size={size} strokeWidth={1.5} aria-hidden="true" />
    </ActionIcon>
  );
}

interface DirectorySearchProps {
  search: Pick<
    DirectorySearchController,
    | 'opened'
    | 'inputRef'
    | 'query'
    | 'caseSensitive'
    | 'useRegex'
    | 'invalidPattern'
    | 'index'
    | 'total'
    | 'changeQuery'
    | 'toggleCaseSensitive'
    | 'toggleRegex'
    | 'navigate'
    | 'selectAll'
  >;
  onClose: () => void;
}

export function DirectorySearch({ search, onClose }: DirectorySearchProps) {
  const { t } = useTranslation('storage');
  const reduceMotion = useReducedMotion();
  const {
    opened,
    inputRef,
    query,
    caseSensitive,
    useRegex,
    invalidPattern,
    index,
    total,
    changeQuery,
    toggleCaseSensitive,
    toggleRegex,
    navigate,
    selectAll,
  } = search;

  const hasMatches = query.length > 0 && total > 0;
  const status = getMatchStatus(query, index, total, invalidPattern, t);

  const assignInputRef = useCallback(
    (node: HTMLInputElement | null) => {
      inputRef.current = node;
      if (node && opened) node.focus({ preventScroll: true });
    },
    [inputRef, opened],
  );

  const focusInput = () => {
    inputRef.current?.focus({ preventScroll: true });
  };

  useKeyboardShortcuts(
    opened
      ? [
          {
            key: 'c',
            altKey: true,
            allowInEditable: true,
            onTrigger: toggleCaseSensitive,
          },
          {
            key: 'r',
            altKey: true,
            allowInEditable: true,
            onTrigger: toggleRegex,
          },
        ]
      : [],
  );

  const handleInputKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (!isMatchNavigationEvent(event)) return;
    event.preventDefault();
    navigate(event.shiftKey ? -1 : 1);
  };

  const handleNavigate = (direction: -1 | 1) => {
    navigate(direction);
    focusInput();
  };

  const handleToggle = (toggle: () => void) => {
    toggle();
    focusInput();
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
          <search className={classes.search} data-invalid={invalidPattern || undefined}>
            <TextInput
              ref={assignInputRef}
              type="search"
              variant="unstyled"
              size="xs"
              className={classes.input}
              aria-label={t('searchDirectory')}
              aria-invalid={invalidPattern || undefined}
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
            <div className={classes.toggles}>
              <SearchActionButton
                label={t('matchSearchCase')}
                shortcut="Alt+C"
                pressed={caseSensitive}
                className={classes.toggle}
                icon={CaseSensitive}
                iconSize={toggleIconSize}
                onClick={() => handleToggle(toggleCaseSensitive)}
              />
              <SearchActionButton
                label={t('useSearchRegex')}
                shortcut="Alt+R"
                pressed={useRegex}
                className={classes.toggle}
                icon={Regex}
                iconSize={toggleIconSize}
                onClick={() => handleToggle(toggleRegex)}
              />
            </div>
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
          </search>
        </div>
      )}
    </Transition>
  );
}
