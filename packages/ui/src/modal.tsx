'use client';

import { X } from 'lucide-react';
import { useEffect, useRef, type ReactNode } from 'react';
import { cn } from './cn';

/**
 * A modal on the native <dialog> element: focus moves in and back, Escape closes it,
 * and the page behind is inert.
 */
export function Modal({
  open,
  title,
  onClose,
  children,
  className,
}: {
  open: boolean;
  title: string;
  onClose: () => void;
  children: ReactNode;
  className?: string;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);

  return (
    <dialog
      ref={ref}
      aria-labelledby="modal-title"
      onClose={onClose}
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
      className={cn(
        'm-auto w-[calc(100%-32px)] max-w-lg rounded-cards bg-limestone p-6 text-obsidian backdrop:bg-obsidian/60 sm:p-10',
        className,
      )}
    >
      {open ? (
        <>
          <div className="mb-6 flex items-start justify-between gap-4">
            <h2 id="modal-title" className="display text-heading">
              {title}
            </h2>
            <button
              type="button"
              onClick={onClose}
              aria-label="Close"
              className="inline-flex size-11 shrink-0 items-center justify-center rounded-pills hover:bg-pumice"
            >
              <X aria-hidden className="size-5" strokeWidth={1.75} />
            </button>
          </div>
          {children}
        </>
      ) : null}
    </dialog>
  );
}
