// @vitest-environment happy-dom
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, it, vi } from 'vitest';
import { AgreementDialog, AgreementVersionDialog, ReplaceAgreementPdfDialog, RevokeSignatureDialog } from './DomainAgreementForms';
afterEach(cleanup);

it('guards agreement edits during save and keeps the exact metadata payload', async () => {
  let finish!: () => void;
  const onSave = vi.fn(() => new Promise<void>((resolve) => { finish = resolve; }));
  const close = vi.fn(); const user = userEvent.setup();
  render(<AgreementDialog isOpen initial={null} onSave={onSave} onClose={close} />);
  await user.type(screen.getByLabelText('Agreement title'), 'Terms');
  await user.click(screen.getByRole('button', { name: 'Close modal' }));
  expect(screen.getByText('Discard unsaved changes?')).toBeTruthy();
  await user.click(screen.getByRole('button', { name: 'Keep editing' }));
  await user.click(screen.getByRole('button', { name: 'Save agreement' }));
  await waitFor(() => expect(onSave).toHaveBeenCalledWith({ title: 'Terms', description: null, displayOrder: 0, requiredForAccess: true }));
  await user.keyboard('{Escape}');
  expect(close).not.toHaveBeenCalled();
  await act(async () => finish());
  expect(close).toHaveBeenCalledOnce();
});

it('protects a selected upload even before metadata changes', async () => {
  const close = vi.fn(); const user = userEvent.setup();
  render(<AgreementVersionDialog isOpen initial={null} onSave={vi.fn()} onClose={close} />);
  await user.upload(screen.getByLabelText(/Source PDF/), new File(['pdf'], 'terms.pdf', { type: 'application/pdf' }));
  await user.keyboard('{Escape}');
  expect(close).not.toHaveBeenCalled();
  expect(screen.getByText('Discard unsaved changes?')).toBeTruthy();
});

it('retains replacement PDF after failure and blocks pending dismissal', async () => {
  let finish!: () => void;
  const replace = vi.fn().mockRejectedValueOnce(new Error('offline')).mockImplementationOnce(() => new Promise<void>((resolve) => { finish = resolve; }));
  const close = vi.fn(); const user = userEvent.setup();
  render(<ReplaceAgreementPdfDialog isOpen version={null} onReplace={replace} onClose={close} />);
  const file = new File(['pdf'], 'replacement.pdf', { type: 'application/pdf' });
  await user.upload(screen.getByLabelText('Replacement PDF'), file);
  await user.click(screen.getByRole('button', { name: 'Replace PDF' }));
  expect(await screen.findByText('The PDF could not be replaced.')).toBeTruthy();
  expect(replace).toHaveBeenCalledWith(file);
  await user.click(screen.getByRole('button', { name: 'Replace PDF' }));
  await waitFor(() => expect(replace).toHaveBeenCalledTimes(2));
  await user.keyboard('{Escape}');
  expect(close).not.toHaveBeenCalled();
  await act(async () => finish());
  expect(close).toHaveBeenCalledOnce();
});

it('guards a revocation reason and preserves it through a failed retry', async () => {
  const revoke = vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce(undefined);
  const close = vi.fn(); const user = userEvent.setup();
  render(<RevokeSignatureDialog isOpen onRevoke={revoke} onClose={close} />);
  await user.type(screen.getByLabelText('Required reason'), ' Incorrect signatory ');
  await user.keyboard('{Escape}');
  expect(close).not.toHaveBeenCalled();
  await user.click(screen.getByRole('button', { name: 'Keep editing' }));
  await user.click(screen.getByRole('button', { name: 'Revoke signature' }));
  expect(await screen.findByText(/The signature could not be revoked/)).toBeTruthy();
  expect(revoke).toHaveBeenCalledWith('Incorrect signatory');
  await user.click(screen.getByRole('button', { name: 'Revoke signature' }));
  await waitFor(() => expect(close).toHaveBeenCalledOnce());
});
