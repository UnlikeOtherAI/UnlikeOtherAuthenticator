import { useState } from 'react';

import { Button } from '../ui/Button';
import { Modal } from '../ui/Modal';
import { useAdminUi } from '../../features/shell/admin-ui';

export function ConfirmDialog() {
  const { closeConfirmation, confirmation } = useAdminUi();
  const [confirmationText, setConfirmationText] = useState('');
  const [isPending, setIsPending] = useState(false);
  const [error, setError] = useState('');
  const requiredText = confirmation?.requiredText;
  const isConfirmed = requiredText === undefined || confirmationText === requiredText;

  function closeDialog() {
    if (isPending) return;
    setError('');
    setConfirmationText('');
    setIsPending(false);
    closeConfirmation();
  }

  async function confirmAction() {
    if (!isConfirmed || isPending || !confirmation?.onConfirm) return;
    setError('');
    setIsPending(true);
    try {
      await confirmation.onConfirm();
      setConfirmationText('');
      closeConfirmation();
    } catch {
      setError('The change could not be completed. Try again.');
    } finally {
      setIsPending(false);
    }
  }

  return (
    <Modal
      isOpen={Boolean(confirmation)}
      isPending={isPending}
      onClose={closeDialog}
      title={confirmation?.title ?? 'Are you sure?'}
      widthClassName="max-w-sm"
      footer={
        <>
          <Button disabled={isPending} onClick={closeDialog}>Cancel</Button>
          <Button disabled={!isConfirmed || isPending || !confirmation?.onConfirm} variant="danger" onClick={confirmAction}>
            {isPending ? 'Saving...' : confirmation?.title.replace(/\?$/, '') ?? 'Confirm'}
          </Button>
        </>
      }
    >
      <p className="text-sm text-gray-500">{confirmation?.body ?? 'This action cannot be undone.'}</p>
      {error ? <p role="alert" className="mt-3 text-sm text-red-700">{error}</p> : null}
      {requiredText !== undefined ? (
        <label className="mt-4 block text-sm font-medium text-gray-700">
          Type <span className="font-semibold">{requiredText}</span> to confirm
          <input
            autoComplete="off"
            className="mt-2 w-full rounded-md border border-gray-300 px-3 py-2 text-sm shadow-xs focus:border-indigo-500 focus:outline-hidden focus:ring-2 focus:ring-indigo-200"
            value={confirmationText}
            onChange={(event) => setConfirmationText(event.target.value)}
          />
        </label>
      ) : null}
    </Modal>
  );
}
