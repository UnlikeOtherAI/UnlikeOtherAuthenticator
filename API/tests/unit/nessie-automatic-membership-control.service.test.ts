import { createHmac } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';

import { controlNessieAutomaticMembership } from '../../src/services/nessie-automatic-membership-control.service.js';

const saved = {
  url: process.env.NESSIE_UOA_AUTOMATIC_MEMBERSHIP_CONTROL_URL,
  secret: process.env.NESSIE_UOA_AUTOMATIC_MEMBERSHIP_CONTROL_SECRET,
};
const secret = 'automatic-membership-test-secret-long-enough';

afterEach(() => {
  process.env.NESSIE_UOA_AUTOMATIC_MEMBERSHIP_CONTROL_URL = saved.url;
  process.env.NESSIE_UOA_AUTOMATIC_MEMBERSHIP_CONTROL_SECRET = saved.secret;
});

describe('Nessie automatic membership admin bridge', () => {
  it('signs a UOA-bound request and parses only the documented response', async () => {
    process.env.NESSIE_UOA_AUTOMATIC_MEMBERSHIP_CONTROL_URL = 'https://nessie.example';
    process.env.NESSIE_UOA_AUTOMATIC_MEMBERSHIP_CONTROL_SECRET = secret;
    let received: Request | undefined;
    const result = await controlNessieAutomaticMembership({
      uoaActorSub: 'user_1', externalOrgId: 'org_1', scope: 'organisation', action: 'list',
    }, {
      now: () => 1_700_000_000_000, requestId: () => 'f3c4ba7d-93d6-4ad1-bcd3-b6f62cbdab34',
      fetch: async (input, init) => {
        received = new Request(input, init);
        return new Response(JSON.stringify({ rules: [], audit: [] }), { status: 200 });
      },
    });
    expect(result).toEqual({ rules: [], audit: [] });
    expect(received?.url).toBe('https://nessie.example/api/internal/uoa/automatic-membership/control');
    const body = await received?.text();
    expect(JSON.parse(body ?? '{}')).toMatchObject({ uoa_actor_sub: 'user_1', external_org_id: 'org_1', action: 'list' });
    expect(received?.headers.get('x-uoa-automatic-membership-signature')).toBe(
      createHmac('sha256', secret).update(`1700000000000.${body}`, 'utf8').digest('hex'),
    );
  });

  it('fails closed when the bridge configuration is absent', async () => {
    delete process.env.NESSIE_UOA_AUTOMATIC_MEMBERSHIP_CONTROL_URL;
    delete process.env.NESSIE_UOA_AUTOMATIC_MEMBERSHIP_CONTROL_SECRET;
    await expect(controlNessieAutomaticMembership({
      uoaActorSub: 'user_1', externalOrgId: 'org_1', scope: 'organisation', action: 'list',
    })).rejects.toMatchObject({ statusCode: 404, message: 'AUTOMATIC_MEMBERSHIP_CONTROL_NOT_CONFIGURED' });
  });
});
