/**
 * Shared keyboard and focus behavior for modal dialogs.
 *
 * Modal entries form a small stack so nested dialogs consume Escape one layer
 * at a time. The capture listener also keeps Escape from reaching the
 * Composer's global abort shortcut.
 */

import { useLayoutEffect, useRef, type RefObject } from 'react';

const FOCUSABLE_SELECTOR = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

interface ModalEntry {
  readonly dialogRef: RefObject<HTMLElement | null>;
  readonly initialFocusRef?: RefObject<HTMLElement | null>;
  readonly activeRef: RefObject<boolean>;
  readonly onCloseRef: RefObject<() => void>;
}

const modalStack: ModalEntry[] = [];

function topModal(): ModalEntry | undefined {
  return modalStack.findLast((entry) => entry.activeRef.current);
}

function focusableElements(dialog: HTMLElement): HTMLElement[] {
  return Array.from(dialog.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(
    (element) => element.getAttribute('aria-hidden') !== 'true' && !element.closest('[inert]'),
  );
}

function focusFirst(entry: ModalEntry, backwards = false): void {
  const dialog = entry.dialogRef.current;
  if (dialog === null) return;
  const elements = focusableElements(dialog);
  const target = entry.initialFocusRef?.current ?? (backwards ? elements.at(-1) : elements[0]) ?? dialog;
  target.focus();
}

function onModalKeyDown(event: KeyboardEvent): void {
  const entry = topModal();
  if (entry === undefined) return;

  if (event.key === 'Escape') {
    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation();
    entry.onCloseRef.current();
    return;
  }

  if (event.key !== 'Tab') return;
  const dialog = entry.dialogRef.current;
  if (dialog === null) return;
  const elements = focusableElements(dialog);
  const activeElement = document.activeElement;
  const first = elements[0];
  const last = elements.at(-1);

  if (elements.length === 0 || !dialog.contains(activeElement)) {
    event.preventDefault();
    focusFirst(entry, event.shiftKey);
  } else if (event.shiftKey && activeElement === first) {
    event.preventDefault();
    (last ?? dialog).focus();
  } else if (!event.shiftKey && activeElement === last) {
    event.preventDefault();
    (first ?? dialog).focus();
  }
}

function onModalFocusIn(event: FocusEvent): void {
  const entry = topModal();
  if (entry === undefined) return;
  const dialog = entry.dialogRef.current;
  if (dialog !== null && !dialog.contains(event.target as Node)) focusFirst(entry);
}

function installGlobalListeners(): void {
  if (modalStack.length !== 1) return;
  window.addEventListener('keydown', onModalKeyDown, true);
  document.addEventListener('focusin', onModalFocusIn, true);
}

function uninstallGlobalListeners(): void {
  if (modalStack.length > 0) return;
  window.removeEventListener('keydown', onModalKeyDown, true);
  document.removeEventListener('focusin', onModalFocusIn, true);
}

export interface ModalDialogOptions {
  /** Temporarily yield to a nested modal without losing focus restoration. */
  readonly active?: boolean;
  readonly initialFocusRef?: RefObject<HTMLElement | null>;
}

/** Trap focus, focus the dialog on mount, restore focus, and consume Escape. */
export function useModalDialog(
  dialogRef: RefObject<HTMLElement | null>,
  onClose: () => void,
  options: ModalDialogOptions = {},
): void {
  const activeRef = useRef(options.active ?? true);
  const onCloseRef = useRef(onClose);
  activeRef.current = options.active ?? true;
  onCloseRef.current = onClose;

  useLayoutEffect(() => {
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const entry: ModalEntry = {
      dialogRef,
      initialFocusRef: options.initialFocusRef,
      activeRef,
      onCloseRef,
    };
    modalStack.push(entry);
    installGlobalListeners();

    if (entry.activeRef.current) {
      const dialog = dialogRef.current;
      if (dialog !== null && !dialog.contains(document.activeElement)) focusFirst(entry);
    }

    return () => {
      const index = modalStack.indexOf(entry);
      if (index !== -1) modalStack.splice(index, 1);
      uninstallGlobalListeners();
      if (previousFocus?.isConnected) previousFocus.focus();
    };
  }, [dialogRef, options.initialFocusRef]);
}
