import { useCallback, useLayoutEffect, useRef } from 'react';

/** A pending response may deliver UI state only to its original committed owner. */
export function useAsyncDeliveryScope(scope: string | null) {
  const generation = useRef(0);
  const active = useRef(false);
  const committedScope = useRef(scope);
  useLayoutEffect(() => {
    if (committedScope.current !== scope) {
      generation.current += 1;
      committedScope.current = scope;
    }
    active.current = scope !== null;
    const invalidate = () => { generation.current += 1; };
    window.addEventListener('uoa-admin-session-cleared', invalidate);
    return () => {
      active.current = false;
      // StrictMode replays the same owner. A real unmount leaves it inactive;
      // a committed scope change above permanently invalidates earlier delivery.
      window.removeEventListener('uoa-admin-session-cleared', invalidate);
    };
  }, [scope]);
  return useCallback(() => {
    const issuedIn = generation.current;
    const wasActive = active.current;
    return () => wasActive && active.current && issuedIn === generation.current;
  }, []);
}
