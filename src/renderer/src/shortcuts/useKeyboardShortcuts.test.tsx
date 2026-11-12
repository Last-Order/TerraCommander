import { fireEvent, render, renderHook } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { useKeyboardShortcuts, type KeyboardShortcut } from './useKeyboardShortcuts';

function keyDown(init: KeyboardEventInit, target: Element | Window = window) {
  const event = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init });
  fireEvent(target, event);
  return event;
}

it('matches keys without case sensitivity and requires the exact modifiers', () => {
  const onTrigger = vi.fn();
  const other = vi.fn();
  renderHook(() =>
    useKeyboardShortcuts([
      { key: 'k', ctrlKey: true, shiftKey: true, onTrigger },
      { key: 'F2', onTrigger: other },
    ]),
  );

  for (const init of [
    { key: 'k' },
    { key: 'k', ctrlKey: true },
    { key: 'k', ctrlKey: true, shiftKey: true, altKey: true },
    { key: 'k', ctrlKey: true, shiftKey: true, metaKey: true },
    { key: 'x', ctrlKey: true, shiftKey: true },
  ]) {
    expect(keyDown(init).defaultPrevented).toBe(false);
  }
  expect(onTrigger).not.toHaveBeenCalled();

  const event = keyDown({ key: 'K', ctrlKey: true, shiftKey: true });
  expect(event.defaultPrevented).toBe(true);
  expect(onTrigger).toHaveBeenCalledExactlyOnceWith(event);
  keyDown({ key: 'F2' });
  expect(other).toHaveBeenCalledTimes(1);
});

it('reserves disabled and repeated shortcuts and respects composition and handled events', () => {
  const onTrigger = vi.fn();
  const { rerender } = renderHook(
    ({ enabled }) => useKeyboardShortcuts([{ key: 'F5', onTrigger, enabled }]),
    { initialProps: { enabled: false } },
  );
  expect(keyDown({ key: 'F5' }).defaultPrevented).toBe(true);
  rerender({ enabled: true });
  expect(keyDown({ key: 'F5', repeat: true }).defaultPrevented).toBe(true);
  expect(keyDown({ key: 'F5', isComposing: true }).defaultPrevented).toBe(false);
  const handled = new KeyboardEvent('keydown', { key: 'F5', cancelable: true });
  handled.preventDefault();
  fireEvent(window, handled);
  expect(onTrigger).not.toHaveBeenCalled();

  keyDown({ key: 'F5' });
  expect(onTrigger).toHaveBeenCalledTimes(1);
});

it('leaves editable controls alone unless the binding explicitly includes them', () => {
  const onTrigger = vi.fn();
  const { container } = render(
    <>
      <input aria-label="Name" />
      <textarea aria-label="Description" />
      <select aria-label="Location" />
      <div contentEditable suppressContentEditableWarning>
        <span>Editable</span>
      </div>
    </>,
  );
  const { rerender } = renderHook(
    ({ allowInEditable }) => useKeyboardShortcuts([{ key: 'Delete', onTrigger, allowInEditable }]),
    { initialProps: { allowInEditable: false } },
  );

  for (const target of container.querySelectorAll('input, textarea, select, span')) {
    expect(keyDown({ key: 'Delete' }, target).defaultPrevented).toBe(false);
  }
  expect(onTrigger).not.toHaveBeenCalled();
  rerender({ allowInEditable: true });
  expect(keyDown({ key: 'Delete' }, container.querySelector('input')!).defaultPrevented).toBe(true);
  expect(onTrigger).toHaveBeenCalledTimes(1);
});

it('uses the latest bindings and removes the listener when its owner unmounts', () => {
  const previous = vi.fn();
  const current = vi.fn();
  const { rerender, unmount } = renderHook(({ bindings }) => useKeyboardShortcuts(bindings), {
    initialProps: { bindings: [{ key: 'F5', onTrigger: previous }] as KeyboardShortcut[] },
  });
  rerender({ bindings: [{ key: 'F2', onTrigger: current }] });
  expect(keyDown({ key: 'F5' }).defaultPrevented).toBe(false);
  expect(keyDown({ key: 'F2' }).defaultPrevented).toBe(true);
  expect(previous).not.toHaveBeenCalled();
  expect(current).toHaveBeenCalledTimes(1);

  unmount();
  expect(keyDown({ key: 'F2' }).defaultPrevented).toBe(false);
  expect(current).toHaveBeenCalledTimes(1);
});
