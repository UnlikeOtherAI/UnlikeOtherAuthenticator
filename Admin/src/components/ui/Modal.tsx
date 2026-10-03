import { useEffect, useRef, useId, useState, type ReactNode } from 'react';

import { Icon } from '../icons/Icon';
import { cn } from '../../utils/cn';

type ModalProps = {
  children: ReactNode;
  footer?: ReactNode;
  isOpen: boolean;
  onClose: () => void;
  title: string;
  widthClassName?: string;
  isPending?: boolean;
  isDirty?: boolean;
};

export function Modal({ children, footer, isOpen, onClose, title, widthClassName = 'max-w-lg', isPending = false, isDirty = false }: ModalProps) {
  const dialog = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose);
  const pendingRef = useRef(isPending);
  const dirtyRef = useRef(isDirty);
  const titleId = useId();
  const [discard, setDiscard] = useState(false);
  closeRef.current = onClose;
  pendingRef.current = isPending;
  dirtyRef.current = isDirty;
  function requestClose() {
    if (pendingRef.current) return;
    if (dirtyRef.current) { setDiscard(true); return; }
    closeRef.current();
  }
  useEffect(() => {
    if (!isOpen) return;
    setDiscard(false);
    const previous = document.activeElement as HTMLElement | null;
    const overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    dialog.current?.focus();
    function onKey(event: KeyboardEvent) {
      const stack = document.querySelectorAll('[role="dialog"][aria-modal="true"]');
      if (stack[stack.length - 1] !== dialog.current) return;
      if (event.key === 'Escape') { event.preventDefault(); requestClose(); }
      if (event.key !== 'Tab') return;
      const nodes = Array.from(dialog.current?.querySelectorAll<HTMLElement>('a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex="0"]') ?? []).filter((node) => !node.hidden && node.getAttribute('aria-hidden') !== 'true');
      const first = nodes[0]; const last = nodes[nodes.length - 1];
      if (!first) { event.preventDefault(); dialog.current?.focus(); return; }
      if (event.shiftKey && (document.activeElement === first || document.activeElement === dialog.current)) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && (document.activeElement === last || document.activeElement === dialog.current)) { event.preventDefault(); first.focus(); }
    }
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('keydown', onKey); document.body.style.overflow = overflow; if (previous?.isConnected) previous.focus(); };
  }, [isOpen]);
  if (!isOpen) {
    return null;
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 px-4" onMouseDown={requestClose}>
      <div ref={dialog} tabIndex={-1} role="dialog" aria-modal="true" aria-labelledby={titleId} aria-busy={isPending} className={cn('max-h-[90vh] w-full overflow-hidden rounded-2xl bg-white shadow-2xl outline-none', widthClassName)} onMouseDown={(event) => event.stopPropagation()}>
        <div className="flex items-center justify-between border-b border-gray-100 px-6 py-4">
          <h2 id={titleId} className="text-sm font-semibold text-gray-900">{title}</h2>
          <button disabled={isPending} className="rounded-lg p-1 text-gray-400 transition-colors hover:bg-gray-100 hover:text-gray-700" type="button" onClick={requestClose} aria-label="Close modal">
            <Icon name="close" className="h-4 w-4" />
          </button>
        </div>
        <div className="max-h-[70vh] overflow-y-auto px-6 py-5">{children}</div>
        {discard ? <div role="alert" className="flex flex-wrap items-center gap-3 border-t border-amber-200 bg-amber-50 px-6 py-3 text-sm"><span>Discard unsaved changes?</span><button type="button" className="font-semibold text-indigo-700" onClick={() => setDiscard(false)}>Keep editing</button><button type="button" disabled={isPending} className="font-semibold text-red-700 disabled:opacity-50" onClick={() => { if (pendingRef.current) return; setDiscard(false); closeRef.current(); }}>Discard changes</button></div> : null}
        {footer ? <div className="flex justify-end gap-2 border-t border-gray-100 bg-gray-50 px-6 py-3">{footer}</div> : null}
      </div>
    </div>
  );
}
