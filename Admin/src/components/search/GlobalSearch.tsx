import { useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router';

import { Icon } from '../icons/Icon';
import { Badge } from '../ui/Badge';
import { adminService } from '../../services/admin-service';
import type { SearchResult } from '../../features/admin/types';
import { useDirectoryNavigation } from '../../features/admin/useDirectoryNavigation';

export function GlobalSearch() {
  const { recordState } = useDirectoryNavigation('/dashboard');
  const [inputValue, setInputValue] = useState('');
  const [query, setQuery] = useState('');
  const rootRef = useRef<HTMLDivElement | null>(null);
  const { data = [], isFetching, isError, refetch } = useQuery({
    queryKey: ['admin', 'search', query],
    queryFn: () => adminService.search(query),
    enabled: query.length > 0,
  });

  useEffect(() => {
    const timer = window.setTimeout(() => setQuery(inputValue.trim()), 120);
    return () => window.clearTimeout(timer);
  }, [inputValue]);

  useEffect(() => {
    function onClick(event: MouseEvent) {
      if (!rootRef.current?.contains(event.target as Node)) {
        setInputValue('');
      }
    }

    document.addEventListener('mousedown', onClick);
    return () => document.removeEventListener('mousedown', onClick);
  }, []);

  const isOpen = inputValue.trim().length > 0;

  function resultPath(result: SearchResult) {
    if (result.type === 'organisation') {
      return `/organisations/${result.organisation.id}`;
    }

    if (result.type === 'team') {
      return `/organisations/${result.organisation.id}/teams/${result.team.id}`;
    }

    return `/users/${result.user.id}`;
  }

  return (
    <div ref={rootRef} className="relative w-40 shrink-0 sm:w-64 md:w-80">
      <Icon name="search" className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-gray-400" />
      <input
        className="h-9 w-full rounded-lg border border-gray-200 bg-gray-50 pl-9 pr-3 text-sm text-gray-900 outline-hidden placeholder:text-gray-400 focus:border-indigo-500 focus:bg-white focus:ring-2 focus:ring-indigo-100"
        type="search"
        aria-label="Search users, organisations and teams"
        value={inputValue}
        placeholder="Search orgs, teams, users..."
        onChange={(event) => setInputValue(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            setInputValue('');
          }
        }}
      />
      {isOpen ? (
        <div className="absolute left-0 right-0 top-11 z-50 max-h-96 overflow-y-auto rounded-xl border border-gray-200 bg-white shadow-xl">
          {isFetching || query !== inputValue.trim() ? <p role="status" className="p-4 text-sm text-gray-500">Searching...</p> : isError ? <div role="alert" className="p-4 text-sm text-red-700">Search failed. <button type="button" onClick={() => void refetch()}>Try again</button></div> : data.length > 0 ? (
            <div className="py-1">
              {data.map((result) => (
                <Link key={searchKey(result)} state={recordState} to={resultPath(result)} className="flex w-full items-center gap-2 px-3 py-2 text-left transition-colors hover:bg-indigo-50" onClick={() => setInputValue('')}>
                  <ResultAvatar result={result} />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium text-gray-900">{resultLabel(result)}</span>
                    <span className="block truncate text-xs text-gray-400">{resultSubLabel(result)}</span>
                  </span>
                  {result.type === 'user' ? <Badge variant={result.user.status === 'banned' ? 'red' : 'green'}>{result.user.status}</Badge> : null}
                </Link>
              ))}
            </div>
          ) : (
            <p className="px-4 py-4 text-center text-sm text-gray-400">No results for "{inputValue.trim()}"</p>
          )}
          <div className="border-t border-gray-100 px-3 py-2 text-center text-[11px] text-gray-400">Esc closes search</div>
        </div>
      ) : null}
    </div>
  );
}

function ResultAvatar({ result }: { result: SearchResult }) {
  const label = resultLabel(result);
  const className = result.type === 'team' ? 'bg-blue-100 text-blue-700' : result.type === 'organisation' ? 'bg-indigo-100 text-indigo-700' : 'bg-green-100 text-green-700';

  return <span className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-xs font-semibold ${className}`}>{initials(label)}</span>;
}

function searchKey(result: SearchResult) {
  if (result.type === 'organisation') {
    return `org-${result.organisation.id}`;
  }

  if (result.type === 'team') {
    return `team-${result.team.id}`;
  }

  return `user-${result.user.id}`;
}

function resultLabel(result: SearchResult) {
  if (result.type === 'organisation') {
    return result.organisation.name;
  }

  if (result.type === 'team') {
    return result.team.name;
  }

  return result.user.name ?? result.user.email;
}

function resultSubLabel(result: SearchResult) {
  if (result.type === 'organisation') {
    return `${result.organisation.slug} · ${result.organisation.members.length} members`;
  }

  if (result.type === 'team') {
    return `${result.organisation.name} · ${result.team.members} members`;
  }

  return result.user.domains.join(', ');
}

function initials(value: string) {
  return value
    .split(' ')
    .map((word) => word[0])
    .join('')
    .slice(0, 2)
    .toUpperCase();
}
