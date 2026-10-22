import { EventEmitter } from 'node:events';
import type { FastifyInstance } from 'fastify';
import { afterEach, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ state: vi.fn(), subscribe: vi.fn() }));
vi.mock('../../src/services/pending-registration.service.js', () => ({ pendingRegistrationState: mocks.state }));
vi.mock('../../src/services/registration-events.service.js', () => ({ subscribeRegistrationChanges: mocks.subscribe }));
vi.mock('../../src/routes/auth/registration-context.js', () => ({ registrationContext: () => ({}) }));
import { registerRegistrationWebSocket } from '../../src/routes/auth/registration-websocket.js';

afterEach(() => { vi.useRealTimers(); vi.clearAllMocks(); });

it('delivers approval arriving during the initial database read without waiting for the polling timer', async () => {
  vi.useFakeTimers();
  const id = '9466e365-206c-49cb-a8d5-aa1342bdd613';
  let resolveInitial!: (value: { status: string }) => void;
  mocks.state.mockReturnValueOnce(new Promise(resolve => { resolveInitial = resolve; }))
    .mockResolvedValue({ status: 'authorized' });
  let notify!: () => void;
  const unsubscribe = vi.fn();
  mocks.subscribe.mockImplementation((_id, callback) => { notify = callback; return unsubscribe; });
  const socket = Object.assign(new EventEmitter(), { send: vi.fn(), close: vi.fn() });
  const get = vi.fn();
  registerRegistrationWebSocket({ get } as unknown as FastifyInstance);
  const handler = get.mock.calls[0][2];
  handler(socket, { query: { id }, cookies: {}, adminDb: {} });
  notify();
  resolveInitial({ status: 'pending' });
  await vi.advanceTimersByTimeAsync(0);
  expect(mocks.state).toHaveBeenCalledTimes(2);
  expect(socket.send).toHaveBeenCalledExactlyOnceWith(JSON.stringify({ type: 'registration.email_verified', status: 'verified' }));
  socket.emit('close');
  expect(unsubscribe).toHaveBeenCalledOnce();
  expect(vi.getTimerCount()).toBe(0);
});
