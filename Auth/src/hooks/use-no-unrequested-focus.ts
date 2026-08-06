import { useEffect, useRef, type RefObject } from 'react';

const INTERACTION_EVENTS = ['pointerdown', 'touchstart', 'keydown'] as const;

/**
 * Keeps the soft keyboard closed when a view first appears.
 *
 * No auth view asks for focus on the login screen, but its email field can still end up
 * focused on arrival: browser focus restoration on back/bfcache navigation, a password
 * manager, or a user agent that focuses the first field of the server-rendered form
 * before hydration. On a phone that opens the keyboard straight away, which shrinks the
 * visual viewport and pushes the social sign-in buttons off screen.
 *
 * Focus that lands inside the returned ref's subtree before the user's first pointer or
 * key interaction is therefore dropped. `pointerdown`/`touchstart`/`keydown` all fire
 * before the focus they cause, so a real tap or Tab is marked as user intent first and
 * keeps its focus.
 */
export function useNoUnrequestedFocus<T extends HTMLElement>(): RefObject<T | null> {
  const ref = useRef<T | null>(null);

  useEffect(() => {
    const root = ref.current;
    if (!root) return;

    let userActed = false;
    const markUserAction = (): void => {
      userActed = true;
    };
    const dropUnrequestedFocus = (): void => {
      if (userActed) return;
      const active = document.activeElement as HTMLElement | null;
      if (active && active !== root && root.contains(active)) active.blur();
    };

    // Covers focus applied before hydration; the listener covers anything later.
    dropUnrequestedFocus();

    for (const type of INTERACTION_EVENTS) {
      window.addEventListener(type, markUserAction, true);
    }
    root.addEventListener('focusin', dropUnrequestedFocus);

    return () => {
      for (const type of INTERACTION_EVENTS) {
        window.removeEventListener(type, markUserAction, true);
      }
      root.removeEventListener('focusin', dropUnrequestedFocus);
    };
  }, []);

  return ref;
}
