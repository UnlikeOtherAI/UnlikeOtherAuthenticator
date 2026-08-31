import { useState } from 'react';

import { Button } from '../ui/Button';
import { Modal } from '../ui/Modal';
import { useAdminUi } from '../../features/shell/admin-ui';

export function ConfirmDialog() {
  const { closeConfirmation, confirmation } = useAdminUi();
  const [confirmationText, setConfirmationText] = useState('');
  const [isPending, setIsPending] = useState(false);
  const requiredText = confirmation?.requiredText;
  const isConfirmed = requiredText === undefined || confirmationText === requiredText;

  function closeDialog() {
    setConfirmationText('');
    setIsPending(false);
    closeConfirmation();
  }

  async function confirmAction() {
    if (!isConfirmed || isPending) return;
    setIsPending(true);
    try {
      await confirmation?.onConfirm?.();
    } finally {
      closeDialog();
    }
  }

  return (
    <Modal
      isOpen={Boolean(confirmation)}
      onClose={closeDialog}
      title={confirmation?.title ?? 'Are you sure?'}
      widthClassName="max-w-sm"
      footer={
        <>
          <Button onClick={closeDialog}>Cancel</Button>
          <Button disabled={!isConfirmed || isPending} variant="danger" onClick={confirmAction}>
            {isPending ? 'Confirming...' : 'Confirm'}
          </Button>
        </>
      }
    >
      <p className="text-sm text-gray-500">{confirmation?.body ?? 'This action cannot be undone.'}</p>
      {requiredText !== undefined ? (
        <label className="mt-4 block text-sm font-medium text-gray-700">
          Type <span className="font-semibold">{requiredText}</span> to confirm
          <input
            autoComplete="off"
            className="mt-2 w-full rounded-md border border-gray-300 px-3 py-2 text-sm shadow-sm focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-200"
            value={confirmationText}
            onChange={(event) => setConfirmationText(event.target.value)}
          />
        </label>
      ) : null}
    </Modal>
  );
}
