import type { ReactNode } from 'react';

import { Icon } from '../icons/Icon';
import { cn } from '../../utils/cn';

type ModalProps = {
  children: ReactNode;
  footer?: ReactNode;
  isOpen: boolean;
  onClose: () => void;
  title: string;
  widthClassName?: string;
};

export function Modal({ children, footer, isOpen, onClose, title, widthClassName = 'max-w-lg' }: ModalProps) {
  if (!isOpen) {
    return null;
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 px-4" role="dialog" aria-modal="true" aria-label={title} onMouseDown={onClose}>
      <div className={cn('max-h-[90vh] w-full overflow-hidden rounded-2xl bg-white shadow-2xl', widthClassName)} onMouseDown={(event) => event.stopPropagation()}>
        <div className="flex items-center justify-between border-b border-gray-100 px-6 py-4">
          <h2 className="text-sm font-semibold text-gray-900">{title}</h2>
          <button className="rounded-lg p-1 text-gray-400 transition-colors hover:bg-gray-100 hover:text-gray-700" type="button" onClick={onClose} aria-label="Close modal">
            <Icon name="close" className="h-4 w-4" />
          </button>
        </div>
        <div className="max-h-[70vh] overflow-y-auto px-6 py-5">{children}</div>
        {footer ? <div className="flex justify-end gap-2 border-t border-gray-100 bg-gray-50 px-6 py-3">{footer}</div> : null}
      </div>
    </div>
  );
}
