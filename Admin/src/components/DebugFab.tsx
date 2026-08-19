import { useCallback, useMemo, useState } from 'react';

import { adminEnv } from '../config/env';
import { readStoredAdminSession } from '../features/auth/admin-session-storage';
import { Button } from './ui/Button';
import { Icon } from './icons/Icon';
import { Modal } from './ui/Modal';

// Floating debug button (bottom-right, mounted inside the post-login AdminLayout
// behind an import.meta.env.DEV gate). Opens a modal pre-filled with non-secret
// session diagnostics — decoded header/claims, expiry, origin — so a superuser can
// hand support exactly what they see.
//
// Docs/Admin/architecture-admin.md: the UI must never extract or display the Bearer
// credential or any product credential, so the snapshot decodes the JWT but never
// includes the token itself or anything that would replay /internal/admin/*.

function decodeJwtSegment(segment: string): unknown {
  if (!segment) return null;
  try {
    const normalized = segment.replace(/-/g, '+').replace(/_/g, '/');
    const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=');
    const bytes = Uint8Array.from(window.atob(padded), (char) => char.charCodeAt(0));
    return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
  } catch {
    return null;
  }
}

function buildSnapshot(): Record<string, unknown> {
  const apiBaseUrl = adminEnv.apiBaseUrl || window.location.origin;
  const cookies = document.cookie || '(no JS-readable cookies — admin auth uses a Bearer token, not cookies)';
  const stored = readStoredAdminSession();

  if (!stored) {
    return {
      capturedAt: new Date().toISOString(),
      origin: window.location.origin,
      apiBaseUrl,
      mode: 'unauthenticated',
      message: 'No admin session token in storage. Sign in, then capture again.',
      cookies,
    };
  }

  const [headerSegment, payloadSegment] = stored.accessToken.split('.');

  return {
    capturedAt: new Date().toISOString(),
    origin: window.location.origin,
    apiBaseUrl,
    session: {
      expiresAt: new Date(stored.expiresAt).toISOString(),
      expiresInSeconds: Math.max(0, Math.round((stored.expiresAt - Date.now()) / 1000)),
      expired: stored.expiresAt <= Date.now(),
    },
    accessTokenHeader: decodeJwtSegment(headerSegment ?? ''),
    accessTokenClaims: decodeJwtSegment(payloadSegment ?? ''),
    cookies,
  };
}

export function DebugFab() {
  const [isOpen, setIsOpen] = useState(false);
  const [copied, setCopied] = useState(false);

  const json = useMemo(() => (isOpen ? JSON.stringify(buildSnapshot(), null, 2) : ''), [isOpen]);

  const close = useCallback(() => {
    setIsOpen(false);
    setCopied(false);
  }, []);

  const onCopy = useCallback(() => {
    if (!json) return;
    void navigator.clipboard.writeText(json).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    });
  }, [json]);

  return (
    <>
      <button
        type="button"
        onClick={() => setIsOpen(true)}
        aria-label="Debug session snapshot"
        title="Debug session snapshot"
        className="fixed bottom-5 right-5 z-40 flex h-11 w-11 items-center justify-center rounded-full border border-gray-200 bg-white text-gray-500 shadow-lg transition-colors hover:bg-gray-50 hover:text-gray-900"
      >
        <Icon name="bug" className="h-5 w-5" />
      </button>
      <Modal
        isOpen={isOpen}
        onClose={close}
        title="Session debug snapshot"
        widthClassName="max-w-xl"
        footer={
          <>
            <Button variant="secondary" onClick={close}>
              Cancel
            </Button>
            <Button variant="primary" icon={copied ? 'check' : 'copy'} onClick={onCopy}>
              {copied ? 'Copied' : 'Copy'}
            </Button>
          </>
        }
      >
        <div className="space-y-3">
          <p className="text-xs text-gray-500">
            Non-secret diagnostics for this admin session — decoded token claims, expiry, and
            origin. Paste it to support to describe exactly what you see; the access token itself is
            never included.
          </p>
          <textarea
            readOnly
            value={json}
            spellCheck={false}
            aria-label="Session snapshot JSON"
            onFocus={(event) => event.currentTarget.select()}
            className="h-72 w-full resize-none rounded-lg border border-gray-200 bg-gray-50 p-3 font-mono text-xs text-gray-800 focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500"
          />
        </div>
      </Modal>
    </>
  );
}
