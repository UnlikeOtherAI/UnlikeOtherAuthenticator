import { Button } from '../components/ui/Button';
import { Modal } from '../components/ui/Modal';
import { useAdminUi } from '../features/shell/admin-ui';

export function ConfirmDialog() {
  const { closeConfirmation, confirmation } = useAdminUi();

  async function confirmAction() {
    await confirmation?.onConfirm?.();
    closeConfirmation();
  }

  return (
    <Modal
      isOpen={Boolean(confirmation)}
      onClose={closeConfirmation}
      title={confirmation?.title ?? 'Are you sure?'}
      widthClassName="max-w-sm"
      footer={
        <>
          <Button onClick={closeConfirmation}>Cancel</Button>
          <Button variant="danger" onClick={confirmAction}>
            Confirm
          </Button>
        </>
      }
    >
      <p className="text-sm text-gray-500">{confirmation?.body ?? 'This action cannot be undone.'}</p>
    </Modal>
  );
}
