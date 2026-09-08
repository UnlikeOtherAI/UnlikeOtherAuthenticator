import { describe, expect, it } from 'vitest';

import { renderInviteUnavailableHtml } from '../../src/services/team-invite-page.service.js';
import { AppError } from '../../src/utils/errors.js';

describe('renderInviteUnavailableHtml', () => {
  it('names a genuine invitation expiry', () => {
    const html = renderInviteUnavailableHtml(new AppError('BAD_REQUEST', 400, 'INVITE_EXPIRED'));

    expect(html).toContain('Invitation expired');
    expect(html).not.toContain('Invitation invalid');
  });

  it.each([
    new AppError('BAD_REQUEST', 400, 'INVITE_INVALID'),
    new AppError('BAD_REQUEST', 400, 'INVITE_REVOKED'),
    new AppError('BAD_REQUEST', 400, 'TOKEN_ALREADY_USED'),
    new Error('unexpected'),
  ])('uses one invalid result for every non-expiry failure', (error) => {
    const html = renderInviteUnavailableHtml(error);

    expect(html).toContain('Invitation invalid');
    expect(html).not.toContain('Invitation expired');
    expect(html).not.toContain('Invitation revoked');
  });
});
