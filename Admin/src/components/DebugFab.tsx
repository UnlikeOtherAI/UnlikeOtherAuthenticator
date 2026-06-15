import { useCallback, useMemo, useState } from 'react';

import { adminEnv } from '../config/env';
import { readStoredAdminSession } from '../features/auth/admin-session-storage';
import { Button } from './ui/Button';
import { Icon } from './icons/Icon';
import { Modal } from './ui/Modal';

// Floating debug button (bottom-right, mounted inside the post-login AdminLayout).
// Opens a modal pre-filled with the current admin session — the raw JWT access
// token, its decoded header/claims, and any JS-readable cookies — so a superuser
// can copy their exact session and hand it to support to reproduce an issue.
//
// Client-only: the admin credential is a Bearer JWT held in sessionStorage (not
// an httpOnly cookie), so everything needed is already readable in the browser
// and no server endpoint is required. The token is the caller's own and is
// already in their storage, so this reveals nothing they could not read from
// devtools — but it IS the superuser credential, hence the "treat as secret" note.

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
    accessToken: stored.accessToken,
    accessTokenHeader: decodeJwtSegment(headerSegment ?? ''),
    accessTokenClaims: decodeJwtSegment(payloadSegment ?? ''),
    cookies,
    reconstruct: {
      authorizationHeader: `Bearer ${stored.accessToken}`,
      curl: `curl -H 'Authorization: Bearer ${stored.accessToken}' ${apiBaseUrl}/internal/admin/session`,
    },
    notes: [
      'accessToken is your superuser Bearer credential — treat it as a secret.',
      'Send it as the Authorization header to call /internal/admin/* as you until session.expiresAt.',
    ],
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
            Your JWT access token and cookies for this admin session. Paste it to support to reproduce exactly what
            you see — treat it as a secret.
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
