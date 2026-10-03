// @vitest-environment happy-dom
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Link, RouterProvider, createMemoryRouter } from 'react-router';
import { afterEach, expect, it } from 'vitest';
import { useDirectoryNavigation } from './useDirectoryNavigation';
import { useDirectoryParam } from './useDirectoryParam';

afterEach(cleanup);
function Record({ to }: { to?: string }) {
  const { recordState, goBack } = useDirectoryNavigation('/users');
  const [, setTab] = useDirectoryParam('tab');
  return <><button onClick={goBack}>Back</button><button onClick={() => setTab('profile')}>Profile</button>{to ? <Link state={recordState} to={to}>Next record</Link> : null}</>;
}
it('retains service filters and nested return context through a detail tab change', async () => {
  const router = createMemoryRouter([
    { path: '/domains/example.com', element: <Record to="/organisations/org" /> },
    { path: '/organisations/org', element: <Record to="/organisations/org/teams/team" /> },
    { path: '/organisations/org/teams/team', element: <Record to="/users/user" /> },
    { path: '/users/user', element: <Record /> },
  ], { initialEntries: ['/domains/example.com?tab=organisations&q=acme&page=2'] });
  render(<RouterProvider router={router} />);
  const user = userEvent.setup();
  await user.click(screen.getByRole('link', { name: 'Next record' }));
  await user.click(screen.getByRole('button', { name: 'Profile' }));
  await user.click(screen.getByRole('link', { name: 'Next record' }));
  await user.click(screen.getByRole('link', { name: 'Next record' }));
  await user.click(screen.getByRole('button', { name: 'Back' }));
  expect(router.state.location.pathname).toBe('/organisations/org/teams/team');
  await user.click(screen.getByRole('button', { name: 'Back' }));
  expect(router.state.location.pathname + router.state.location.search).toBe('/organisations/org?tab=profile');
  await user.click(screen.getByRole('button', { name: 'Back' }));
  expect(router.state.location.pathname + router.state.location.search).toBe('/domains/example.com?tab=organisations&q=acme&page=2');
});
it('rejects an external return destination', async () => {
  const router = createMemoryRouter([
    { path: '/users/user', element: <Record /> },
    { path: '/users', element: <p>User directory</p> },
  ], { initialEntries: [{ pathname: '/users/user', state: { directoryFrom: '//evil.example.com' } }] });
  render(<RouterProvider router={router} />);
  await userEvent.setup().click(screen.getByRole('button', { name: 'Back' }));
  expect(router.state.location.pathname).toBe('/users');
});
