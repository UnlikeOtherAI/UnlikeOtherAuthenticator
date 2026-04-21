import { useEffect, useMemo, useState, type ReactNode, type TdHTMLAttributes } from 'react';

import { cn } from '../../utils/cn';

type DataTableProps = {
  headers: string[];
  children: ReactNode;
  className?: string;
};

export function DataTable({ children, className, headers }: DataTableProps) {
  return (
    <div className={cn('w-full overflow-x-auto', className)}>
      <table className="w-full min-w-[760px] border-collapse">
        <thead>
          <tr>
            {headers.map((header) => (
              <th key={header} className="border-b border-gray-200 bg-gray-50 px-5 py-2.5 text-left text-[11px] font-semibold uppercase tracking-wide text-gray-500">
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
  return <td {...props} className={cn('border-b border-gray-100 px-5 py-2.5 text-sm text-gray-700', className)}>{children}</td>;
}

type PaginationProps = {
  onPageChange: (page: number) => void;
  onPageSizeChange: (pageSize: number) => void;
  page: number;
  pageSize: number;
  pageSizeOptions?: number[];
  totalItems: number;
};

export function usePagination<T>(items: T[], initialPageSize = 10) {
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(initialPageSize);
  const totalPages = Math.max(1, Math.ceil(items.length / pageSize));
  const currentPage = Math.min(page, totalPages);

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
      onPageChange: setPage,
      onPageSizeChange: (nextPageSize: number) => {
        setPageSize(nextPageSize);
        setPage(1);
      },
      page: currentPage,
      pageSize,
      totalItems: items.length,
    },
  };
}

export function PaginationFooter({ onPageChange, onPageSizeChange, page, pageSize, pageSizeOptions = [5, 10, 25, 50], totalItems }: PaginationProps) {
  const totalPages = Math.max(1, Math.ceil(totalItems / pageSize));
  const start = totalItems === 0 ? 0 : (page - 1) * pageSize + 1;
  const end = Math.min(page * pageSize, totalItems);

  return (
    <div className="flex flex-wrap items-center justify-between gap-3 border-t border-gray-100 px-5 py-3">
      <div className="flex items-center gap-2">
        <span className="text-xs font-medium text-gray-500">Rows per page</span>
        <select
          aria-label="Rows per page"
          className="h-8 rounded-lg border border-gray-200 bg-white px-2 text-xs font-medium text-gray-700 outline-none focus:border-indigo-500 focus:ring-2 focus:ring-indigo-100"
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
