import { ConfidentialDelegationScope } from '@prisma/client';
import { describe, expect, it } from 'vitest';

import {
  resolveConfidentialDelegation,
  resolveConfidentialDelegationForSource,
} from '../../src/services/confidential-delegation.service.js';
import {
  delegationClientDomainId as clientDomainId,
  delegationMapping as mapping,
  delegationProduct as product,
  delegationRequest as request,
  delegationResolverPrisma as resolverPrisma,
  delegationResource as resource,
  delegationSourceDomain as sourceDomain,
} from './confidential-delegation-fixtures.js';

describe('confidential delegation resolution', () => {
  it('returns exactly the requested allowlisted scopes without widening', async () => {
    const { prisma } = resolverPrisma();

    await expect(
      resolveConfidentialDelegation(request({ scope: 'billing.read ai.invoke' }), { prisma }),
    ).resolves.toEqual({
      product,
      resource,
      scope: 'ai.invoke billing.read',
    });

    await expect(
      resolveConfidentialDelegation(request({ scope: 'billing.read' }), {
        prisma,
      }),
    ).resolves.toEqual({
      product,
      resource,
      scope: 'billing.read',
    });
  });

  it('allows token provisioning only when the exact app/product mapping grants it', async () => {
    const { prisma } = resolverPrisma(
      mapping({ scopes: [ConfidentialDelegationScope.TOKEN_PROVISION] }),
    );

    await expect(
      resolveConfidentialDelegation(request({ scope: 'token.provision' }), { prisma }),
    ).resolves.toEqual({
      product,
      resource,
      scope: 'token.provision',
    });
    await expect(
      resolveConfidentialDelegation(request({ scope: 'ai.invoke token.provision' }), { prisma }),
    ).rejects.toMatchObject({
      code: 'FORBIDDEN',
      statusCode: 403,
      message: 'TOKEN_EXCHANGE_DELEGATION_NOT_ALLOWED',
    });
  });

  it('re-resolves the original active source domain before validating a chained hop', async () => {
    const { prisma } = resolverPrisma();

    await expect(
      resolveConfidentialDelegationForSource(
        {
          sourceDomain,
          product,
          resource,
          scope: 'ai.invoke',
        },
        { prisma },
      ),
    ).resolves.toEqual({
      product,
      resource,
      scope: 'ai.invoke',
    });
    expect(prisma.clientDomain.findUnique).toHaveBeenCalledWith({
      where: { domain: sourceDomain },
      select: { id: true, status: true },
    });
  });

  it.each([
    ['another app credential', { authenticatedClientDomainId: 'client-domain-deepwater' }],
    ['another product', { product: 'deepwater' }],
    ['a non-canonical product', { product: 'DeepSignal' }],
    ['another source domain', { sourceDomain: 'api.deepwater.works' }],
    ['another resource', { resource: `${resource}/other` }],
    ['an unsupported scope', { scope: 'admin' }],
    ['token provisioning without a grant', { scope: 'token.provision' }],
    ['duplicate scopes', { scope: 'ai.invoke ai.invoke' }],
    ['scope widening', { scope: 'ai.invoke billing.read' }],
  ])('rejects %s against a single-scope mapping', async (_label, overrides) => {
    const { prisma } = resolverPrisma(mapping({ scopes: [ConfidentialDelegationScope.AI_INVOKE] }));

    await expect(
      resolveConfidentialDelegation(request(overrides), { prisma }),
    ).rejects.toMatchObject({
      code: 'FORBIDDEN',
      statusCode: 403,
      message: 'TOKEN_EXCHANGE_DELEGATION_NOT_ALLOWED',
    });
  });

  it.each([
    ['unknown', null],
    ['disabled', mapping({ enabled: false })],
    [
      'attached to a disabled domain',
      mapping({ clientDomain: { domain: sourceDomain, status: 'disabled' } }),
    ],
  ])('fails closed for a %s mapping', async (_label, row) => {
    const { prisma } = resolverPrisma(row);
    await expect(resolveConfidentialDelegation(request(), { prisma })).rejects.toThrow(
      'TOKEN_EXCHANGE_DELEGATION_NOT_ALLOWED',
    );
  });
});

describe('privileged identity/membership scope pin (global)', () => {
  const pinResource = 'https://authentication.unlikeotherai.com';
  const exactScopes = 'identity.read membership.invite membership.manage';

  function pinnedIdentityMapping(overrides: Record<string, unknown> = {}) {
    return mapping({
      product: 'nessie-identity',
      clientDomain: { domain: 'api.nessie.works', status: 'active' },
      resource: pinResource,
      scopes: [
        ConfidentialDelegationScope.IDENTITY_READ,
        ConfidentialDelegationScope.MEMBERSHIP_INVITE,
        ConfidentialDelegationScope.MEMBERSHIP_MANAGE,
      ],
      ...overrides,
    });
  }

  it('resolves the exact pinned nessie-identity mapping in any scope order', async () => {
    const { prisma } = resolverPrisma(pinnedIdentityMapping());

    await expect(
      resolveConfidentialDelegation(
        request({
          sourceDomain: 'api.nessie.works',
          product: 'nessie-identity',
          resource: pinResource,
          scope: 'membership.manage identity.read membership.invite',
        }),
        { prisma },
      ),
    ).resolves.toEqual({
      product: 'nessie-identity',
      resource: pinResource,
      scope: exactScopes,
    });
  });

  it('coexists with the already-used nessie product mapping on the same source', async () => {
    const { prisma } = resolverPrisma(
      mapping({
        product: 'nessie',
        clientDomain: { domain: 'api.nessie.works', status: 'active' },
        scopes: [ConfidentialDelegationScope.AI_INVOKE],
      }),
    );

    await expect(
      resolveConfidentialDelegation(
        request({
          sourceDomain: 'api.nessie.works',
          product: 'nessie',
          resource: 'https://ledger.unlikeotherai.com/v1/mcp/deepwater',
          scope: 'ai.invoke',
        }),
        { prisma },
      ),
    ).resolves.toEqual({
      product: 'nessie',
      resource: 'https://ledger.unlikeotherai.com/v1/mcp/deepwater',
      scope: 'ai.invoke',
    });
  });

  it('narrows the pinned allowlist to a privileged subset on resolve', async () => {
    const { prisma } = resolverPrisma(pinnedIdentityMapping());

    await expect(
      resolveConfidentialDelegation(
        request({
          sourceDomain: 'api.nessie.works',
          product: 'nessie-identity',
          resource: pinResource,
          scope: 'identity.read',
        }),
        { prisma },
      ),
    ).resolves.toEqual({
      product: 'nessie-identity',
      resource: pinResource,
      scope: 'identity.read',
    });
  });

  it.each([
    [
      'deepsignal requesting membership.manage against its own valid mapping',
      request({ scope: 'membership.manage' }),
    ],
    [
      'the nessie product on the pinned source domain',
      request({ sourceDomain: 'api.nessie.works', product: 'nessie', scope: exactScopes }),
    ],
    [
      'a non-UOA resource for the nessie-identity product',
      request({
        sourceDomain: 'api.nessie.works',
        product: 'nessie-identity',
        resource,
        scope: exactScopes,
      }),
    ],
    [
      'a non-Nessie source domain for the nessie-identity product',
      request({ product: 'nessie-identity', resource: pinResource, scope: exactScopes }),
    ],
    [
      'a privileged scope mixed with an unpinned scope',
      request({
        sourceDomain: 'api.nessie.works',
        product: 'nessie-identity',
        resource: pinResource,
        // Widening beyond the allowlist is a denial; plain narrowing to a
        // subset of the pinned allowlist remains a valid exact-subset
        // request and is covered separately.
        scope: 'billing.read identity.read',
      }),
    ],
    [
      'a widened scope set',
      request({
        sourceDomain: 'api.nessie.works',
        product: 'nessie-identity',
        resource: pinResource,
        scope: 'ai.invoke identity.read membership.invite membership.manage',
      }),
    ],
    [
      'a privileged scope mixed into a non-owner scope set',
      request({ scope: 'ai.invoke identity.read' }),
    ],
  ])('rejects %s', async (_label, input) => {
    const { prisma } = resolverPrisma(
      pinnedIdentityMapping({
        clientDomainId,
        clientDomain: { domain: input.sourceDomain, status: 'active' },
      }),
    );

    await expect(resolveConfidentialDelegation(input, { prisma })).rejects.toMatchObject({
      code: 'FORBIDDEN',
      statusCode: 403,
      message: 'TOKEN_EXCHANGE_DELEGATION_NOT_ALLOWED',
    });
  });

  it.each([
    [
      'a drifted stored scope set (narrowed)',
      pinnedIdentityMapping({ scopes: [ConfidentialDelegationScope.IDENTITY_READ] }),
    ],
    [
      'a drifted stored scope set (widened)',
      pinnedIdentityMapping({
        scopes: [
          ConfidentialDelegationScope.IDENTITY_READ,
          ConfidentialDelegationScope.MEMBERSHIP_INVITE,
          ConfidentialDelegationScope.MEMBERSHIP_MANAGE,
          ConfidentialDelegationScope.AI_INVOKE,
        ],
      }),
    ],
    [
      'a drifted stored resource',
      pinnedIdentityMapping({ resource: 'https://ledger.unlikeotherai.com' }),
    ],
    [
      'privileged scopes smuggled onto a non-owner mapping at runtime',
      mapping({
        scopes: [
          ConfidentialDelegationScope.AI_INVOKE,
          ConfidentialDelegationScope.MEMBERSHIP_INVITE,
        ],
      }),
    ],
    [
      // The runtime guard triggers on product alone: even an owner mapping
      // whose stored scopes drifted to contain no privileged scope at all is
      // refused, so drift can never re-open privileged issuance later.
      'an owner mapping drifted to a bare [ai.invoke] scope set',
      pinnedIdentityMapping({ scopes: [ConfidentialDelegationScope.AI_INVOKE] }),
      { scope: 'ai.invoke' },
    ],
    [
      // A stolen `nessie-identity` product key on another active source
      // domain can never resolve, even with the exact pinned scope set.
      'the nessie-identity product key bound to another source domain',
      pinnedIdentityMapping({ clientDomain: { domain: sourceDomain, status: 'active' } }),
      {},
    ],
  ])('fails closed when the stored mapping drifted: %s', async (_label, row, requestOverrides) => {
    // Request the mapping's own (possibly drifted) coordinates so the generic
    // checks pass and only the privileged-binding guard can reject it.
    const input = request({
      sourceDomain: (row.clientDomain as { domain: string }).domain,
      product: row.product as string,
      resource: row.resource as string,
      scope: row.product === 'nessie-identity' ? exactScopes : 'ai.invoke',
      ...(requestOverrides as Record<string, string> | undefined),
    });
    const { prisma } = resolverPrisma(row as ReturnType<typeof mapping>);

    await expect(resolveConfidentialDelegation(input, { prisma })).rejects.toMatchObject({
      code: 'FORBIDDEN',
      statusCode: 403,
      message: 'TOKEN_EXCHANGE_DELEGATION_NOT_ALLOWED',
    });
  });
});
