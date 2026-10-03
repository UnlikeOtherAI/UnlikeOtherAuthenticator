// @vitest-environment happy-dom
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, it, vi } from 'vitest';
import { Modal } from './Modal';
afterEach(cleanup);

it('guards dirty edits and restores focus after closing', async () => {
  const user = userEvent.setup(); const close = vi.fn();
  const trigger = document.createElement('button'); document.body.append(trigger); trigger.focus();
  const view = render(<Modal isOpen isDirty onClose={close} title="Edit"><input aria-label="Name" /></Modal>);
  await user.keyboard('{Escape}');
  expect(close).not.toHaveBeenCalled();
  await user.click(screen.getByRole('button', { name: 'Keep editing' }));
  await user.keyboard('{Escape}');
  await user.click(screen.getByRole('button', { name: 'Discard changes' }));
  expect(close).toHaveBeenCalledOnce();
  view.unmount(); expect(document.activeElement).toBe(trigger); trigger.remove();
});

it('only the topmost dialog handles Escape and pending operations cannot dismiss', async () => {
  const user = userEvent.setup(); const outer = vi.fn(); const inner = vi.fn();
  const view = render(<><Modal isOpen title="Outer" onClose={outer}><button>Outer action</button></Modal><Modal isOpen isPending title="Inner" onClose={inner}><button>Inner action</button></Modal></>);
  await user.keyboard('{Escape}'); expect(outer).not.toHaveBeenCalled(); expect(inner).not.toHaveBeenCalled();
  view.rerender(<><Modal isOpen title="Outer" onClose={outer}><button>Outer action</button></Modal><Modal isOpen title="Inner" onClose={inner}><button>Inner action</button></Modal></>);
  const dialog = screen.getByRole('dialog', { name: 'Inner' });
  within(dialog).getByRole('button', { name: 'Inner action' }).focus();
  await user.tab(); expect(document.activeElement).toBe(within(dialog).getByRole('button', { name: 'Close modal' }));
  await user.keyboard('{Escape}'); expect(inner).toHaveBeenCalledOnce(); expect(outer).not.toHaveBeenCalled();
});

it('does not discard through an already-open warning once a save begins', async () => {
  const close = vi.fn(); const user = userEvent.setup();
  const view = render(<Modal isOpen isDirty title="Edit" onClose={close}>Draft</Modal>);
  await user.keyboard('{Escape}');
  expect(screen.getByText('Discard unsaved changes?')).toBeTruthy();
  view.rerender(<Modal isOpen isDirty isPending title="Edit" onClose={close}>Draft</Modal>);
  await user.click(screen.getByRole('button', { name: 'Discard changes' }));
  await user.keyboard('{Escape}');
  expect(close).not.toHaveBeenCalled();
});
