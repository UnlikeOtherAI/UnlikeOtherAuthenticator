// @vitest-environment happy-dom

import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { AdminUiProvider, useAdminUi } from '../../features/shell/admin-ui';
import { ConfirmDialog } from './ConfirmDialog';

afterEach(cleanup);

function ConfirmationLauncher({ onConfirm }: { onConfirm: () => void }) {
  const { confirm } = useAdminUi();

  return (
    <button
      type="button"
      onClick={() =>
        confirm(
          'Delete Acme?',
          'This permanently deletes the organisation.',
          onConfirm,
          'Acme',
        )
      }
    >
      Delete
    </button>
  );
}

describe('ConfirmDialog', () => {
  it('keeps a failed mutation open with input intact for retry', async () => {
    const onConfirm = vi.fn().mockRejectedValueOnce(new Error('Failed')).mockResolvedValue(undefined);
    const user = userEvent.setup();
    render(<AdminUiProvider><ConfirmationLauncher onConfirm={onConfirm} /><ConfirmDialog /></AdminUiProvider>);
    await user.click(screen.getByRole('button', { name: 'Delete' }));
    await user.type(screen.getByRole('textbox'), 'Acme');
    await user.click(screen.getByRole('button', { name: 'Delete Acme' }));
    expect(screen.getByRole('alert').textContent).toContain('Try again');
    expect((screen.getByRole('textbox') as HTMLInputElement).value).toBe('Acme');
    await user.click(screen.getByRole('button', { name: 'Delete Acme' }));
    expect(onConfirm).toHaveBeenCalledTimes(2); expect(screen.queryByRole('dialog')).toBeNull();
  });
  it('requires the configured confirmation text before enabling the destructive action', async () => {
    const onConfirm = vi.fn();
    const user = userEvent.setup();
    render(
      <AdminUiProvider>
        <ConfirmationLauncher onConfirm={onConfirm} />
        <ConfirmDialog />
      </AdminUiProvider>,
    );

    await user.click(screen.getByRole('button', { name: 'Delete' }));
    const confirmButton = screen.getByRole('button', { name: 'Delete Acme' }) as HTMLButtonElement;
    const confirmationInput = screen.getByRole('textbox', {
      name: 'Type Acme to confirm',
    });
    expect(confirmButton.disabled).toBe(true);

    await user.type(confirmationInput, 'Not Acme');
    expect(confirmButton.disabled).toBe(true);
    await user.clear(confirmationInput);
    await user.type(confirmationInput, 'Acme');
    expect(confirmButton.disabled).toBe(false);

    await user.click(confirmButton);
    expect(onConfirm).toHaveBeenCalledOnce();
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});

