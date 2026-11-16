import { useLocation, useSearchParams } from 'react-router';

/** Filters that belong to one product tab: `retired=1` on Tariffs, `key_status` on the key tabs. */
const tabLocalParams = ['retired', 'key_status'];

export function useBillingNavigation() {
  const location = useLocation();
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
    setParams(new URLSearchParams(href(changes).split('?')[1] ?? ''), { state: location.state });
  }
  /** A product tab: no record, no table position and no tab-local filter carries over. */
  function tabChanges(tab: string): Record<string, string | null> {
    const cleared = Object.fromEntries([...params.keys()]
      .filter((key) => key.endsWith('_page') || tabLocalParams.includes(key))
      .map((key) => [key, null]));
    return { ...cleared, tab, record: null };
  }
  function tabHref(tab: string) {
    return href(tabChanges(tab));
  }
  function openTab(tab: string) {
    update(tabChanges(tab));
  }
  /** Opens a top-level billing section with none of another section's selection or paging. */
  function openSection(section: string | null) {
    setParams(new URLSearchParams(section ? { section } : {}), { state: location.state });
  }
  return { params, href, update, tabHref, openTab, openSection };
}
