import { useCallback, useEffect, useState } from 'react';

const cookieMaxAgeSeconds = 60 * 60 * 24 * 180;

export function useCookieState<T extends string>(cookieName: string, fallback: T, allowedValues: readonly T[]) {
  const [value, setValue] = useState<T>(() => readCookieValue(cookieName, fallback, allowedValues));

  useEffect(() => {
    setValue(readCookieValue(cookieName, fallback, allowedValues));
  }, [allowedValues, cookieName, fallback]);

  const updateValue = useCallback(
    (nextValue: T) => {
      setValue(nextValue);
      writeCookieValue(cookieName, nextValue);
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
