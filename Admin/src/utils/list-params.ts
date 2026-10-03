import { useLocation, useSearchParams } from 'react-router';

/** List state belongs in the URL so record navigation and Back retain context. */
export function useListParams() {
  const location = useLocation();
  const [params, setParams] = useSearchParams();
  return {
    params,
    get: (key: string, fallback = '') => params.get(key) ?? fallback,
    set: (key: string, value: string, reset = true) => setParams((current) => {
      const next = new URLSearchParams(current);
      if (value) next.set(key, value); else next.delete(key);
      if (reset) { next.delete('page'); next.delete('selected'); }
      return next;
    }, { replace: reset, state: location.state }),
  };
}
