import { describe, expect, it } from 'vitest';

import { attestAutomaticMembershipDomain } from '../../src/services/automatic-membership.service.js';

const credential = {
  id: 'key', purpose: 'AUTOMATIC_MEMBERSHIP', actorIssuer: 'https://nessie.works', actorAudience: 'https://authentication.unlikeotherai.com/org', actorKeyId: 'key', actorPublicJwk: {}, checkoutReturnOrigins: [], service: { id: 'nessie', identifier: 'nessie', name: 'Nessie' },
} as never;

describe('automatic membership verified-domain attestation', () => {
  it('accepts only a UOA identity currently verified for the exact domain', async () => {
    const prisma = { authIdentity: { findMany: async () => [{ email: 'person@engineering.example.com' }, { email: 'person@other.example' }] } } as never;
    const proof = await attestAutomaticMembershipDomain(prisma, credential, { subject: 'uoa-subject', domain: 'engineering.example.com' });
    expect(proof?.subject).toBe('uoa-subject');
    expect(proof?.domain).toBe('engineering.example.com');
    await expect(attestAutomaticMembershipDomain(prisma, credential, { subject: 'uoa-subject', domain: 'example.com' })).resolves.toBeNull();
  });
});
