import { useEffect, useRef } from "react";

const FOCUSABLE_SELECTORS = [
  'button:not([disabled]):not([aria-hidden="true"])',
  '[href]:not([aria-hidden="true"])',
  'input:not([disabled]):not([type="hidden"]):not([aria-hidden="true"])',
  'select:not([disabled]):not([aria-hidden="true"])',
  'textarea:not([disabled]):not([aria-hidden="true"])',
  '[tabindex]:not([tabindex="-1"]):not([disabled]):not([aria-hidden="true"])',
].join(", ");

export interface UseDialogA11yOptions {
  initialFocusSelector?: string;
  disableBodyScroll?: boolean;
  closeOnEscape?: boolean;
  trapFocus?: boolean;
}

/**
 * Custom React hook for accessible modal dialogs and slide-over drawers.
 * Implements WCAG 2.1 AA dialog keyboard interactions:
 * - Escape key dismissal
 * - Tab / Shift+Tab focus trap within container
 * - Auto-focus initial element or container
 * - Restores focus to the triggering element on close
 * - Background body scroll locking
 */
export function useDialogA11y(
  isOpen: boolean,
  onClose: () => void,
  containerRef: React.RefObject<HTMLElement | null>,
  options: UseDialogA11yOptions = {}
) {
  const {
    initialFocusSelector,
    disableBodyScroll = true,
    closeOnEscape = true,
    trapFocus = true,
  } = options;

  const previousFocusedElement = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!isOpen) return;

    // Record the element that held focus before the dialog opened
    if (document.activeElement instanceof HTMLElement) {
      previousFocusedElement.current = document.activeElement;
    }

    // Lock background scroll if requested
    const originalBodyOverflow = document.body.style.overflow;
    if (disableBodyScroll) {
      document.body.style.overflow = "hidden";
    }

    // Set initial focus inside the dialog
    const focusTimer = window.setTimeout(() => {
      if (!containerRef.current) return;

      if (initialFocusSelector) {
        const customEl = containerRef.current.querySelector<HTMLElement>(initialFocusSelector);
        if (customEl) {
          customEl.focus();
          return;
        }
      }

      // Default: Find the first focusable element or the close button
      const focusables = Array.from(
        containerRef.current.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTORS)
      );
      if (focusables.length > 0) {
        focusables[0].focus();
      } else {
        containerRef.current.focus();
      }
    }, 40);

    // Keyboard handler for Escape and Tab trapping
    const handleKeyDown = (e: KeyboardEvent) => {
      if (closeOnEscape && e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        onClose();
        return;
      }

      if (trapFocus && e.key === "Tab" && containerRef.current) {
        const focusables = Array.from(
          containerRef.current.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTORS)
        );

        if (focusables.length === 0) {
          e.preventDefault();
          return;
        }

        const firstEl = focusables[0];
        const lastEl = focusables[focusables.length - 1];

        if (e.shiftKey) {
          if (document.activeElement === firstEl || !containerRef.current.contains(document.activeElement)) {
            e.preventDefault();
            lastEl.focus();
          }
        } else {
          if (document.activeElement === lastEl || !containerRef.current.contains(document.activeElement)) {
            e.preventDefault();
            firstEl.focus();
          }
        }
      }
    };

    window.addEventListener("keydown", handleKeyDown);

    return () => {
      window.clearTimeout(focusTimer);
      window.removeEventListener("keydown", handleKeyDown);

      if (disableBodyScroll) {
        document.body.style.overflow = originalBodyOverflow;
      }

      // Restore focus to previously active element
      if (previousFocusedElement.current && typeof previousFocusedElement.current.focus === "function") {
        previousFocusedElement.current.focus();
      }
    };
  }, [isOpen, onClose, containerRef, initialFocusSelector, disableBodyScroll, closeOnEscape, trapFocus]);
}
