import helmet from '@fastify/helmet';
import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';

import { sendAvatar } from '../../src/routes/avatar/shared.js';
import type { ResolvedAvatar } from '../../src/services/avatar.service.js';

const avatar: ResolvedAvatar = {
  source: 'generated',
  contentType: 'image/svg+xml; charset=utf-8',
  body: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'),
  etag: '"avatar-etag"',
  cacheControl: 'private, max-age=86400',
  filename: 'avatar.svg',
  isSvg: true,
};

describe('avatar response policy', () => {
  it('allows only explicitly public avatar responses to render cross-origin', async () => {
    const app = Fastify();
    await app.register(helmet);
    app.get('/credentialed', (request, reply) => sendAvatar(request, reply, avatar));
    app.get('/public', (request, reply) =>
      sendAvatar(request, reply, avatar, { crossOrigin: true, hideSource: true }),
    );

    try {
      const [credentialed, publicAvatar] = await Promise.all([
        app.inject({ method: 'GET', url: '/credentialed' }),
        app.inject({ method: 'GET', url: '/public' }),
      ]);

      expect(credentialed.headers['cross-origin-resource-policy']).toBe('same-origin');
      expect(publicAvatar.headers['cross-origin-resource-policy']).toBe('cross-origin');
      expect(publicAvatar.headers['x-uoa-avatar-source']).toBeUndefined();
    } finally {
      await app.close();
    }
  });
});
