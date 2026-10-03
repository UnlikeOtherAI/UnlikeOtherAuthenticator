import { useSearchParams } from 'react-router';

export function useBillingNavigation() {
  const [params, setParams] = useSearchParams();
  function href(changes: Record<string, string | null>) {
    const next = new URLSearchParams(params);
    for (const [key, value] of Object.entries(changes)) {
      if (value) next.set(key, value);
      else next.delete(key);
    }
    return `/billing${next.size ? `?${next}` : ''}`;
  }
  function update(changes: Record<string, string | null>) {
    setParams(new URLSearchParams(href(changes).split('?')[1] ?? ''));
  }
  return { params, href, update };
}
