import { useEffect, useRef, type RefObject } from 'react';

const INTERACTION_EVENTS = ['pointerdown', 'touchstart', 'keydown'] as const;

/**
 * How long after mount unrequested focus is still treated as "the view arriving". Focus that
 * lands later is somebody's decision — a password manager the user invoked, a screen reader
 * moving through the form — and is left alone even if no pointer/key event preceded it.
 */
const ARRIVAL_WINDOW_MS = 1000;

/** Only these open a soft keyboard; blurring anything else is pure harm. */
function opensSoftKeyboard(element: HTMLElement): boolean {
  const tag = element.tagName;
  if (tag === 'TEXTAREA') return true;
  if (element.isContentEditable) return true;
  if (tag !== 'INPUT') return false;
  // Checkboxes, radios and buttons-as-inputs focus without raising a keyboard.
  return !['button', 'checkbox', 'radio', 'submit', 'reset', 'file'].includes(
    (element as HTMLInputElement).type,
  );
}

/**
 * Keeps the soft keyboard closed while a view is arriving.
 *
 * No auth view asks for focus on the login screen, but its email field can still end up
 * focused on arrival: browser focus restoration on back/bfcache navigation, a password
 * manager, or a user agent that focuses the first field of the server-rendered form
 * before hydration. On a phone that opens the keyboard straight away, which shrinks the
 * visual viewport and pushes the social sign-in buttons off screen.
 *
 * The guard is deliberately narrow, because "focus nobody asked for" and "focus assistive
 * tech just moved" are indistinguishable from inside the page:
 *
 *  - It only ever blurs a control that would raise a keyboard, never a button or a link.
 *  - It stops at the user's first pointer or key event. `pointerdown`/`touchstart`/`keydown`
 *    all fire before the focus they cause, so a real tap or Tab is marked as intent first.
 *  - It stops {@link ARRIVAL_WINDOW_MS} after mount regardless. A screen reader walking into
 *    the form, or an autofill the user triggered, moves focus with no preceding pointer or key
 *    event — outside the arrival window that focus is theirs and is left alone.
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
      if (!active || active === root || !root.contains(active)) return;
      if (!opensSoftKeyboard(active)) return;
      active.blur();
    };

    const stop = (): void => {
      for (const type of INTERACTION_EVENTS) {
        window.removeEventListener(type, markUserAction, true);
      }
      root.removeEventListener('focusin', dropUnrequestedFocus);
    };

    // Covers focus applied before hydration; the listener covers the rest of the arrival window.
    dropUnrequestedFocus();

    for (const type of INTERACTION_EVENTS) {
      window.addEventListener(type, markUserAction, true);
    }
    root.addEventListener('focusin', dropUnrequestedFocus);
    const timer = setTimeout(stop, ARRIVAL_WINDOW_MS);

    return () => {
      clearTimeout(timer);
      stop();
    };
  }, []);

  return ref;
}
