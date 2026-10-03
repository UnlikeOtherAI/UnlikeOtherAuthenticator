import { useLocation, useSearchParams } from 'react-router';

/** Preserve directory filters in links/history and reset paging when a filter changes. */
export function useDirectoryParam(key: string, fallback = '') {
  const location = useLocation();
  const [params, setParams] = useSearchParams();
  const value = params.get(key) ?? fallback;
  function setValue(next: string) {
    setParams((current) => {
      const updated = new URLSearchParams(current);
      if (next === fallback) updated.delete(key); else updated.set(key, next);
      updated.delete('page');
      return updated;
    }, { replace: key === 'q', state: location.state });
  }
  return [value, setValue] as const;
}
