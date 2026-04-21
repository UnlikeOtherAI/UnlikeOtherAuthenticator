import type { FastifyRequest } from 'fastify';
import { describe, expect, it } from 'vitest';

import {
  assertVerifiedDomainMatchesQuery,
  normalizeDomain,
} from '../../src/routes/org/domain-context.js';

function makeRequest(domain: string): FastifyRequest {
  return { config: { domain } } as unknown as FastifyRequest;
}

describe('org domain context', () => {
  it('normalizes domains for case-insensitive route comparisons', () => {
    expect(normalizeDomain(' Client.EXAMPLE.com. ')).toBe('client.example.com');
  });

  it('accepts matching query and verified config domains without overwriting config', () => {
    const request = makeRequest('Client.EXAMPLE.com.');

    assertVerifiedDomainMatchesQuery(request, 'client.example.com');

    expect((request as unknown as { config: { domain: string } }).config.domain).toBe(
      'Client.EXAMPLE.com.',
    );
  });

  it('rejects query domains that differ from the verified config domain', () => {
    const request = makeRequest('client.example.com');

    try {
      assertVerifiedDomainMatchesQuery(request, 'other.example.com');
      throw new Error('expected mismatch rejection');
    } catch (err) {
      expect(err).toMatchObject({ message: 'DOMAIN_MISMATCH', statusCode: 400 });
    }
  });

  it('fails loudly when domain context is parsed before config verification', () => {
    const request = {} as FastifyRequest;

    try {
      assertVerifiedDomainMatchesQuery(request, 'client.example.com');
      throw new Error('expected missing config rejection');
    } catch (err) {
      expect(err).toMatchObject({ message: 'CONFIG_NOT_VERIFIED', statusCode: 500 });
    }
  });
});
