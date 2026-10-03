import { useContext, useEffect, useMemo, useState, type ReactNode, type TdHTMLAttributes } from 'react';
import { UNSAFE_LocationContext, UNSAFE_NavigationContext } from 'react-router';

import { cn } from '../../utils/cn';
import { useCookieState } from '../../utils/cookie-state';

const tablePageSizeCookieName = 'uoa-admin-table-page-size';
const tablePageSizeOptions = [5, 10, 25, 50] as const;
const tablePageSizeOptionValues = ['5', '10', '25', '50'] as const;

type TablePageSizeOption = (typeof tablePageSizeOptionValues)[number];

type DataTableProps = {
  headers: string[];
  children: ReactNode;
  className?: string;
};

export function DataTable({ children, className, headers }: DataTableProps) {
  return (
    <div className={cn('w-full overflow-x-auto', className)}>
      <table className="w-full border-collapse">
        <thead>
          <tr>
            {headers.map((header) => (
              <th key={header} scope="col" className="border-b border-gray-200 bg-gray-50 px-3 py-2.5 text-left text-[11px] font-semibold uppercase tracking-wide text-gray-500 sm:px-5">
                {header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>{children}</tbody>
      </table>
    </div>
  );
}

type TdProps = TdHTMLAttributes<HTMLTableCellElement> & {
  children: ReactNode;
};

export function Td({ children, className, ...props }: TdProps) {
  return <td {...props} className={cn('border-b border-gray-100 px-3 py-2.5 text-sm text-gray-700 sm:px-5', className)}>{children}</td>;
}

type PaginationProps = {
  onPageChange: (page: number) => void;
  onPageSizeChange: (pageSize: number) => void;
  page: number;
  pageSize: number;
  pageSizeOptions?: readonly number[];
  totalItems: number;
};

export function usePagination<T>(items: T[], initialPageSize = 10, options: { key?: string; resetKey?: string; url?: boolean } = {}) {
  const [page, setPage] = useState(1);
  const location = useContext(UNSAFE_LocationContext)?.location;
  const navigation = useContext(UNSAFE_NavigationContext);
  const key = options.key ?? 'page';
  const params = new URLSearchParams(location?.search);
  const urlPage = Number(params.get(key) ?? 1);
  const useUrl = options.url !== false && !!location && !!navigation;
  const requestedPage = useUrl ? (Number.isSafeInteger(urlPage) && urlPage > 0 ? urlPage : 1) : page;
  const changePage = (next: number) => {
    setPage(next);
    if (!useUrl || !location || !navigation) return;
    const search = new URLSearchParams(location.search);
    if (next > 1) search.set(key, String(next)); else search.delete(key);
    const base = navigation.basename === '/' ? '' : navigation.basename.replace(/\/$/, '');
    navigation.navigator.push({ pathname: `${base}${location.pathname}`, search: search.toString() ? `?${search}` : '', hash: location.hash }, location.state);
  };
  const [storedPageSize, setStoredPageSize] = useCookieState<TablePageSizeOption>(
    tablePageSizeCookieName,
    toPageSizeOption(initialPageSize),
    tablePageSizeOptionValues,
  );
  const pageSize = Number(storedPageSize);
  const totalPages = Math.max(1, Math.ceil(items.length / pageSize));
  const currentPage = Math.min(requestedPage, totalPages);

  useEffect(() => {
    setPage(1);
  }, [pageSize, options.resetKey]);

  useEffect(() => {
    setPage((current) => Math.min(current, totalPages));
  }, [totalPages]);

  const pageItems = useMemo(() => {
    const start = (currentPage - 1) * pageSize;
    return items.slice(start, start + pageSize);
  }, [currentPage, items, pageSize]);

  return {
    pageItems,
    pagination: {
      onPageChange: changePage,
      onPageSizeChange: (nextPageSize: number) => {
        setStoredPageSize(toPageSizeOption(nextPageSize));
        changePage(1);
      },
      page: currentPage,
      pageSize,
      totalItems: items.length,
    },
  };
}

export function PaginationFooter({ onPageChange, onPageSizeChange, page, pageSize, pageSizeOptions = tablePageSizeOptions, totalItems }: PaginationProps) {
  if (totalItems === 0) return null;
  const totalPages = Math.max(1, Math.ceil(totalItems / pageSize));
  const start = totalItems === 0 ? 0 : (page - 1) * pageSize + 1;
  const end = Math.min(page * pageSize, totalItems);

  return (
    <div className="flex flex-wrap items-center justify-between gap-3 border-t border-gray-100 px-5 py-3">
      <div className="flex items-center gap-2">
        <span className="text-xs font-medium text-gray-500">Rows per page</span>
        <select
          aria-label="Rows per page"
          className="h-8 rounded-lg border border-gray-200 bg-white px-2 text-xs font-medium text-gray-700 outline-hidden focus:border-indigo-500 focus:ring-2 focus:ring-indigo-100"
          value={pageSize}
          onChange={(event) => onPageSizeChange(Number(event.target.value))}
        >
          {pageSizeOptions.map((option) => (
            <option key={option} value={option}>{option}</option>
          ))}
        </select>
      </div>
      <div className="flex items-center gap-3">
        <span className="text-xs text-gray-400">{start}-{end} of {totalItems}</span>
        <div className="flex gap-1">
          <button className="h-7 rounded-lg border border-gray-200 px-2.5 text-xs font-medium text-gray-600 transition-colors hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-40" type="button" disabled={page <= 1} onClick={() => onPageChange(page - 1)}>
            Prev
          </button>
          <span className="inline-flex h-7 items-center rounded-lg bg-indigo-600 px-2.5 text-xs font-medium text-white">{page} / {totalPages}</span>
          <button className="h-7 rounded-lg border border-gray-200 px-2.5 text-xs font-medium text-gray-600 transition-colors hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-40" type="button" disabled={page >= totalPages} onClick={() => onPageChange(page + 1)}>
            Next
          </button>
        </div>
      </div>
    </div>
  );
}

function toPageSizeOption(pageSize: number): TablePageSizeOption {
  const stringValue = String(pageSize) as TablePageSizeOption;

  return tablePageSizeOptionValues.includes(stringValue) ? stringValue : '10';
}
