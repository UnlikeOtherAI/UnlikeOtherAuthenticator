import type { ReactNode } from 'react';

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

export function Td({ children, className }: { children: ReactNode; className?: string }) {
  return <td className={cn('border-b border-gray-100 px-5 py-2.5 text-sm text-gray-700', className)}>{children}</td>;
}

export function PaginationFooter() {
  return (
    <div className="flex items-center justify-between border-t border-gray-100 px-5 py-3">
      <span className="text-xs text-gray-400">Showing sample data</span>
      <div className="flex gap-1">
        <button className="h-7 rounded-lg border border-gray-200 px-2.5 text-xs font-medium text-gray-600 transition-colors hover:bg-gray-50" type="button">
          Prev
        </button>
        <button className="h-7 rounded-lg bg-indigo-600 px-2.5 text-xs font-medium text-white" type="button">
          1
        </button>
        <button className="h-7 rounded-lg border border-gray-200 px-2.5 text-xs font-medium text-gray-600 transition-colors hover:bg-gray-50" type="button">
          2
        </button>
        <button className="h-7 rounded-lg border border-gray-200 px-2.5 text-xs font-medium text-gray-600 transition-colors hover:bg-gray-50" type="button">
          Next
        </button>
      </div>
    </div>
  );
}
