import { expect, it } from 'vitest';
import { loginCsv } from './activity';
it('exports all filtered rows with CSV escaping and formula protection', () => {
  const csv = loginCsv([{ id: 'event', userId: 'user', occurredAt: '2026-10-03T12:00:00.000Z', ts: 'ignored', user: '=formula@example.com', domain: 'example.com', method: 'google', ip: '', userAgent: 'Agent,"quoted"\nnext line', result: 'ok' }]);
  expect(csv).toContain('"\'=formula@example.com"');
  expect(csv).toContain('"Agent,""quoted""\nnext line"');
  expect(csv).toContain('2026-10-03T12:00:00.000Z');
});
