import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import { getPublicBaseUrl } from '../../config/env.js';
import { configVerifier } from '../../middleware/config-verifier.js';
import { pendingRegistrationState } from '../../services/pending-registration.service.js';
import { registrationCookieName, REGISTRATION_TTL_MS } from '../../services/registration-credentials.js';
import { subscribeRegistrationChanges } from '../../services/registration-events.service.js';
import { AppError } from '../../utils/errors.js';
import { registrationContext } from './registration-context.js';

export function registerRegistrationWebSocket(app: FastifyInstance): void {
  const subscriptions = new Map<string, number>();
  let total = 0;
  app.get('/auth/registration/events', {
    websocket: true,
    preHandler: [async request => {
      if (request.headers.origin !== new URL(getPublicBaseUrl()).origin) throw new AppError('FORBIDDEN', 403, 'REGISTRATION_UNAVAILABLE');
    }, configVerifier, async request => {
      const { id } = z.object({ id: z.string().uuid() }).parse(request.query);
      await pendingRegistrationState({ ...registrationContext(request), id,
        credential: request.cookies[registrationCookieName(id)] ?? '' }, request.adminDb);
      if (total >= 256 || (subscriptions.get(id) ?? 0) >= 2) throw new AppError('RATE_LIMITED', 429, 'REGISTRATION_UNAVAILABLE');
    }],
  }, (socket, request) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.query);
    const params = { ...registrationContext(request), id, credential: request.cookies[registrationCookieName(id)] ?? '' };
    total += 1;
    subscriptions.set(id, (subscriptions.get(id) ?? 0) + 1);
    let checking = false;
    let closed = false;
    let lastStatus = '';
    const check = async () => {
      if (checking || closed) return;
      checking = true;
      try {
        const state = await pendingRegistrationState(params, request.adminDb);
        if (closed) return;
        if (state.status === 'expired' || state.status === 'complete') { socket.close(1000); return; }
        if (state.status !== lastStatus) {
          lastStatus = state.status;
          if (state.status === 'verified' || state.status === 'authorized') {
            socket.send(JSON.stringify({ type: 'registration.email_verified', status: 'verified' }));
          }
        }
      } catch { socket.close(1011); }
      finally { checking = false; }
    };
    const unsubscribe = subscribeRegistrationChanges(id, () => { void check(); });
    // Local notifications are immediate. A bounded database recheck delivers
    // changes made on another Cloud Run replica without requiring affinity.
    const timer = setInterval(() => { void check(); }, 5000);
    const deadline = setTimeout(() => socket.close(1000), REGISTRATION_TTL_MS);
    timer.unref(); deadline.unref();
    const cleanup = () => {
      if (closed) return;
      closed = true;
      clearInterval(timer); clearTimeout(deadline); unsubscribe();
      total -= 1;
      const count = (subscriptions.get(id) ?? 1) - 1;
      if (count) subscriptions.set(id, count); else subscriptions.delete(id);
    };
    socket.on('close', cleanup);
    socket.on('error', cleanup);
    socket.on('message', () => socket.close(1008)); // Notifications are server-to-client only.
    void check(); // Verification before subscription is never lost.
  });
}
