import { useCallback, useEffect, useState } from 'react';

const cookieMaxAgeSeconds = 60 * 60 * 24 * 180;
const cookieStateChangedEvent = 'uoa-admin-cookie-state-changed';

type CookieStateChangedDetail = {
  cookieName: string;
  value: string;
};

export function useCookieState<T extends string>(cookieName: string, fallback: T, allowedValues: readonly T[]) {
  const [value, setValue] = useState<T>(() => readCookieValue(cookieName, fallback, allowedValues));

  useEffect(() => {
    setValue(readCookieValue(cookieName, fallback, allowedValues));
  }, [allowedValues, cookieName, fallback]);

  useEffect(() => {
    if (typeof window === 'undefined') {
      return undefined;
    }

    const handleCookieStateChanged = (event: Event) => {
      const detail = (event as CustomEvent<CookieStateChangedDetail>).detail;

      if (detail?.cookieName === cookieName) {
        setValue(readCookieValue(cookieName, fallback, allowedValues));
      }
    };

    window.addEventListener(cookieStateChangedEvent, handleCookieStateChanged);

    return () => window.removeEventListener(cookieStateChangedEvent, handleCookieStateChanged);
  }, [allowedValues, cookieName, fallback]);

  const updateValue = useCallback(
    (nextValue: T) => {
      setValue(nextValue);
      writeCookieValue(cookieName, nextValue);
      dispatchCookieStateChanged(cookieName, nextValue);
    },
    [cookieName],
  );

  return [value, updateValue] as const;
}

function readCookieValue<T extends string>(cookieName: string, fallback: T, allowedValues: readonly T[]) {
  if (typeof document === 'undefined') {
    return fallback;
  }

  const encodedName = `${encodeURIComponent(cookieName)}=`;
  const rawCookie = document.cookie.split('; ').find((cookie) => cookie.startsWith(encodedName));
  const rawValue = rawCookie ? decodeURIComponent(rawCookie.slice(encodedName.length)) : '';

  return allowedValues.includes(rawValue as T) ? (rawValue as T) : fallback;
}

function writeCookieValue(cookieName: string, value: string) {
  if (typeof document === 'undefined') {
    return;
  }

  document.cookie = `${encodeURIComponent(cookieName)}=${encodeURIComponent(value)}; Max-Age=${cookieMaxAgeSeconds}; Path=/; SameSite=Lax`;
}

function dispatchCookieStateChanged(cookieName: string, value: string) {
  if (typeof window === 'undefined') {
    return;
  }

  window.dispatchEvent(new CustomEvent<CookieStateChangedDetail>(cookieStateChangedEvent, { detail: { cookieName, value } }));
}
