import { useEffect } from "react";

/**
 * Sets document.title dynamically, restoring previous title on unmount.
 */
export function useDocumentTitle(title?: string | null): void {
  useEffect(() => {
    const prev = document.title;
    if (title && title.trim()) {
      document.title = `${title.trim()} — DocPilot`;
    } else {
      document.title = "DocPilot — Secure Document Collection";
    }

    return () => {
      document.title = prev;
    };
  }, [title]);
}
