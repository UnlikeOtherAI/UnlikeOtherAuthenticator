// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ get: vi.fn() }));
vi.mock('../utils/api.js', () => ({ getJson: mocks.get }));
import { useRegistrationStatus } from './use-registration-status.js';

afterEach(() => { vi.unstubAllGlobals(); });
it('rechecks an event arriving while an older pending-state request is in flight', async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  let resolveInitial: (value: unknown) => void = () => {};
  mocks.get.mockReturnValueOnce(new Promise(resolve => { resolveInitial = resolve; }))
    .mockResolvedValue({ ok: true, data: { status: 'verified' } });
  class Socket {
    static current: Socket;
    onopen: (() => void) | null = null;
    onmessage: (() => void) | null = null;
    onclose: (() => void) | null = null;
    onerror: (() => void) | null = null;
    constructor() { Socket.current = this; }
    close() { this.onclose?.(); }
  }
  vi.stubGlobal('WebSocket', Socket);
  const received = vi.fn();
  const query = { config_url: 'https://product.example/config' };
  function Harness() {
    useRegistrationStatus({ id: 'pending-registration', query, onState: received });
    return null;
  }
  const host = document.createElement('div'); document.body.appendChild(host);
  const root = createRoot(host);
  try {
    await act(async () => { root.render(<Harness />); });
    await act(async () => {
      Socket.current.onmessage?.();
      resolveInitial({ ok: true, data: { status: 'pending' } });
    });
    expect(mocks.get).toHaveBeenCalledTimes(2);
    expect(received).toHaveBeenLastCalledWith({ status: 'verified' });
  } finally { act(() => root.unmount()); host.remove(); }
});
