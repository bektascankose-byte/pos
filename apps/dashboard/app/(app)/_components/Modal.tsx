"use client";

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

/**
 * A dialog that doesn't take you off the page.
 *
 * Built on `<dialog showModal()>` rather than a hand-rolled overlay, which
 * gets three things right for free that are easy to get wrong: focus moves
 * into the dialog and is trapped there, Escape closes it, and the rest of the
 * page becomes inert to both the mouse and a screen reader.
 *
 * The one thing it does not give free is closing on a backdrop click — the
 * backdrop is part of the dialog element, so a click on it targets the dialog
 * itself, which is what the click handler below distinguishes.
 *
 * **Rendered through a portal into `document.body`, and that is load-bearing.**
 * A modal opened from inside a form — the catalog's bulk-action bar, say —
 * would otherwise put its own `<form>` inside that one, and nested forms are
 * invalid HTML: clicking the inner submit button submits the *outer* form and
 * navigates the whole page. That failure is quiet and looks like "the dialog
 * closed and nothing saved", which is exactly what it did before the portal.
 */
export function Modal({
  open,
  onClose,
  title,
  description,
  children,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: string;
  children: React.ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  // `document` doesn't exist during the server render, so the portal target is
  // only available once mounted.
  const [mounted, setMounted] = useState(false);

  useEffect(() => setMounted(true), []);

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open, mounted]);

  if (!mounted) return null;

  return createPortal(
    <dialog
      ref={ref}
      // `cancel` is Escape. Without preventing the default the dialog closes
      // itself, leaving React's `open` prop saying it is still open — and the
      // next attempt to open it then does nothing.
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
      /*
       * A modal is its own surface, so nothing that happens inside it may
       * reach the tree it was rendered from.
       *
       * The portal moves the DOM node to `document.body`, but React's
       * synthetic events still travel the *component* tree — so a dialog
       * opened from inside a form sent its own submit straight up into that
       * form's `onSubmit`. Creating a price group from the row editor
       * therefore also saved and closed the row editor, which looked like the
       * dialog randomly dismissing everything. Stopping here is what makes
       * the portal a real boundary rather than only a visual one.
       *
       * Children handle their own events first, being deeper in the tree, so
       * nothing inside the dialog loses anything by this.
       */
      onSubmit={(e) => e.stopPropagation()}
      onClick={(e) => {
        e.stopPropagation();
        if (e.target === ref.current) onClose();
      }}
      /*
       * Escape is handled here rather than left to `onCancel` above, because
       * the `stopPropagation` that follows suppresses it: the browser's own
       * "Escape closes a dialog" is driven by this very keydown, so stopping
       * it stopped that too, and the dialog could only be dismissed by mouse.
       * Closing explicitly restores it without reopening the boundary.
       */
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.preventDefault();
          onClose();
        }
        e.stopPropagation();
      }}
      className="w-[min(32rem,calc(100vw-2rem))] rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-0 text-[var(--color-text)] backdrop:bg-black/40"
    >
      <div className="flex flex-col gap-4 p-5">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 className="text-base font-semibold">{title}</h2>
            {description ? (
              <p className="text-xs text-[var(--color-text-muted)]">{description}</p>
            ) : null}
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="rounded-md px-2 py-1 text-lg leading-none text-[var(--color-text-muted)] hover:bg-[var(--color-border)]"
          >
            ×
          </button>
        </div>
        {children}
      </div>
    </dialog>,
    document.body,
  );
}
