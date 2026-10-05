import fastify from 'fastify';
import { describe, expect, it } from 'vitest';

import { registerErrorHandler } from '../../src/middleware/error-handler.js';

describe('seat capacity admission error', () => {
  it('maps a database capacity refusal to one safe conflict code', async () => {
    const app = fastify();
    registerErrorHandler(app);
    app.post('/org/admit', async () => {
      throw new Error('ConnectorError(PostgresError { code: "PZ001", message: "Fixed seat capacity exceeded" })');
    });
    try {
      const response = await app.inject({ method: 'POST', url: '/org/admit' });
      expect(response.statusCode).toBe(409);
      expect(response.json()).toMatchObject({ code: 'SEAT_CAPACITY_EXCEEDED' });
      expect(response.body).not.toContain('subscription');
    } finally {
      await app.close();
    }
  });
});
