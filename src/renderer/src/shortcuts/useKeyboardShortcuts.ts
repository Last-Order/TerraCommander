import { useEffect } from 'react';

export interface KeyboardShortcut {
  key: string;
  altKey?: boolean;
  ctrlKey?: boolean;
  metaKey?: boolean;
  shiftKey?: boolean;
  enabled?: boolean;
  allowInEditable?: boolean;
  onTrigger: (event: KeyboardEvent) => void;
}

function matchesShortcut(event: KeyboardEvent, shortcut: KeyboardShortcut) {
  return (
    event.key.toLowerCase() === shortcut.key.toLowerCase() &&
    event.altKey === (shortcut.altKey ?? false) &&
    event.ctrlKey === (shortcut.ctrlKey ?? false) &&
    event.metaKey === (shortcut.metaKey ?? false) &&
    event.shiftKey === (shortcut.shiftKey ?? false)
  );
}

function isEditable(target: EventTarget | null) {
  if (!(target instanceof Element)) return false;
  if (target.closest('input, textarea, select')) return true;
  const editable = target.closest('[contenteditable]');
  return editable !== null && editable.getAttribute('contenteditable') !== 'false';
}

/** Window shortcuts reserve matching keys while disabled, repeating, or behind a modal. */
export function useKeyboardShortcuts(shortcuts: readonly KeyboardShortcut[]) {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing) return;
      const shortcut = shortcuts.find((binding) => matchesShortcut(event, binding));
      if (!shortcut || (!shortcut.allowInEditable && isEditable(event.target))) return;

      event.preventDefault();
      if (
        shortcut.enabled === false ||
        event.repeat ||
        document.querySelector('[aria-modal="true"], dialog[open]')
      ) {
        return;
      }
      shortcut.onTrigger(event);
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [shortcuts]);
}
