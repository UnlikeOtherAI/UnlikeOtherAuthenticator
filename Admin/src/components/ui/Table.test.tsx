// @vitest-environment happy-dom
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Link, MemoryRouter, Route, Routes, useLocation, useNavigate } from 'react-router';
import { afterEach, expect, it } from 'vitest';
import { PaginationFooter, usePagination } from './Table';
afterEach(cleanup);
const records = Array.from({ length: 30 }, (_, i) => i + 1);
function List() {
  const location = useLocation(); const { pageItems, pagination } = usePagination(records);
  return <><p>{location.search}</p>{pageItems.map((id) => <Link key={id} to={`/record/${id}`}>Record {id}</Link>)}<PaginationFooter {...pagination} /></>;
}
function Detail() { const navigate = useNavigate(); return <button onClick={() => navigate(-1)}>Back</button>; }
it('restores URL pagination through a detail visit and browser Back', async () => {
  const user = userEvent.setup();
  render(<MemoryRouter initialEntries={['/list?page=2']}><Routes><Route path="/list" element={<List />} /><Route path="/record/:id" element={<Detail />} /></Routes></MemoryRouter>);
  expect(screen.queryByRole('link', { name: 'Record 1', exact: true })).toBeNull();
  await user.click(screen.getByRole('link', { name: 'Record 11', exact: true }));
  await user.click(screen.getByRole('button', { name: 'Back' }));
  expect(screen.getByText('?page=2')).toBeTruthy();
  await user.click(screen.getByRole('button', { name: 'Next' }));
  expect(screen.getByRole('link', { name: 'Record 21', exact: true })).toBeTruthy();
});
