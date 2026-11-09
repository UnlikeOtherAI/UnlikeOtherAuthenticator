import type { FastifyRequest } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const getPrismaMock = vi.hoisted(() => vi.fn());
const getAdminPrismaMock = vi.hoisted(() => vi.fn());
const runWithContextMock = vi.hoisted(() => vi.fn());
const effectAuthorityMock = vi.hoisted(() => vi.fn());
vi.mock('../../services/tenant-effect-authority.service.js', () => ({
  assertTenantEffectAuthority: effectAuthorityMock,
}));

vi.mock('../../db/prisma.js', () => ({
  getPrisma: getPrismaMock,
  getAdminPrisma: getAdminPrismaMock,
}));

vi.mock('../../db/tenant-context.js', () => ({
  runWithTenantContext: runWithContextMock,
}));

// Import after mocks are registered.
const pluginModule = await import('../tenant-context.plugin.js');
const tenantContextPlugin = pluginModule.default;
const { setTenantContextFromRequest } = pluginModule;

type OnRequestHook = (request: FastifyRequest) => Promise<void>;

function makeApp(): {
  hook: OnRequestHook | null;
  register: () => Promise<void>;
} {
  const hooks: OnRequestHook[] = [];
  const app = {
    decorateRequest: vi.fn(),
    addHook: vi.fn((name: string, fn: OnRequestHook) => {
      if (name === 'onRequest') hooks.push(fn);
    }),
  };

  return {
    get hook() {
      return hooks[0] ?? null;
    },
    register: async () => {
      // biome-ignore lint: plugin signature
      await tenantContextPlugin(app as never, {} as never);
    },
  };
}

function makeRequest(overrides: Partial<FastifyRequest> = {}): FastifyRequest {
  return {
    config: { domain: 'app.example.com' },
    accessTokenClaims: undefined,
    tenantContext: undefined,
    ...overrides,
  } as unknown as FastifyRequest;
}

describe('tenant-context plugin', () => {
  const originalDatabaseUrl = process.env.DATABASE_URL;

  beforeEach(() => {
    // onRequest conditionally wires adminDb/withTenantTx on DATABASE_URL; ensure the
    // real-DB path is taken for these expectations.
    process.env.DATABASE_URL = 'postgres://test/test';
  });

  afterEach(() => {
    if (originalDatabaseUrl === undefined) {
      delete process.env.DATABASE_URL;
    } else {
      process.env.DATABASE_URL = originalDatabaseUrl;
    }
    getPrismaMock.mockReset();
    getAdminPrismaMock.mockReset();
    runWithContextMock.mockReset();
    effectAuthorityMock.mockReset();
  });

  it('registers request decorators and an onRequest hook', async () => {
    const harness = makeApp();
    await harness.register();
    expect(harness.hook).toBeTypeOf('function');
  });

  it('onRequest attaches adminDb and withTenantTx to the request', async () => {
    const adminClient = { id: 'admin' };
    getAdminPrismaMock.mockReturnValue(adminClient);

    const harness = makeApp();
    await harness.register();

    const request = makeRequest();
    const hook = harness.hook;
    if (!hook) throw new Error('onRequest hook not registered');
    await hook(request);

    expect(request.adminDb).toBe(adminClient);
    expect(typeof request.withTenantTx).toBe('function');
  });

  it('withTenantTx throws when tenantContext has not been populated', async () => {
    getAdminPrismaMock.mockReturnValue({});

    const harness = makeApp();
    await harness.register();

    const request = makeRequest();
    const hook = harness.hook;
    if (!hook) throw new Error('onRequest hook not registered');
    await hook(request);

    await expect(request.withTenantTx(async () => null)).rejects.toThrow(
      /tenantContext was set/i,
    );
  });

  // The admin connection for the authority reads is checked out before the tenant transaction takes
  // the user epoch lock and returned before the handler runs (row-level-security.md §10.16).
  function leasingAdminClient(events: string[], leaseTx: object) {
    return {
      $transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>, _options?: unknown) => {
        events.push('lease:open');
        try {
          return await fn(leaseTx);
        } finally {
          events.push('lease:closed');
        }
      }),
    };
  }

  async function tenantRequest(events: string[], leaseTx: object) {
    const tenantClient = { id: 'tenant' };
    getPrismaMock.mockReturnValue(tenantClient);
    getAdminPrismaMock.mockReturnValue(leasingAdminClient(events, leaseTx));
    runWithContextMock.mockImplementation(async (_opts, handler) => {
      events.push('tenant:open');
      return handler({ tx: true });
    });

    const harness = makeApp();
    await harness.register();
    const request = makeRequest({
      tenantContext: { domain: 'app.example.com', orgId: 'org-1', userId: 'user-1' },
    } as never);
    const hook = harness.hook;
    if (!hook) throw new Error('onRequest hook not registered');
    await hook(request);
    return { request, tenantClient };
  }

  it('withTenantTx reads authority on an admin connection leased before the tenant transaction', async () => {
    const events: string[] = [];
    const leaseTx = { id: 'admin-lease' };
    effectAuthorityMock.mockImplementation(async () => { events.push('authority'); });
    const { request, tenantClient } = await tenantRequest(events, leaseTx);

    const result = await request.withTenantTx(async (tx) => {
      events.push('handler');
      return tx;
    });

    expect(result).toEqual({ tx: true });
    expect(events).toEqual(['lease:open', 'tenant:open', 'authority', 'lease:closed', 'handler']);
    expect(effectAuthorityMock).toHaveBeenCalledWith(request, request.tenantContext,
      { tx: true }, leaseTx, undefined);
    expect(runWithContextMock).toHaveBeenCalledWith(
      {
        prisma: tenantClient,
        context: { domain: 'app.example.com', orgId: 'org-1', userId: 'user-1' },
      },
      expect.any(Function),
    );
  });

  it('withTenantTx returns the leased admin connection when authority is refused', async () => {
    const events: string[] = [];
    effectAuthorityMock.mockRejectedValue(new Error('denied'));
    const { request } = await tenantRequest(events, { id: 'admin-lease' });

    await expect(request.withTenantTx(async () => {
      events.push('handler');
      return null;
    })).rejects.toThrow('denied');
    expect(events).toEqual(['lease:open', 'tenant:open', 'lease:closed']);
  });
});

describe('setTenantContextFromRequest', () => {
  it('reads domain from request.config and claims from accessTokenClaims', () => {
    const request = makeRequest({
      accessTokenClaims: {
        userId: 'user-1',
        email: 'a@b.com',
        domain: 'app.example.com',
        clientId: 'c',
        role: 'user',
        org: { org_id: 'org-7', org_role: 'member', teams: [], team_roles: {} },
      },
    } as never);

    setTenantContextFromRequest(request);

    expect(request.tenantContext).toEqual({
      domain: 'app.example.com',
      orgId: 'org-7',
      userId: 'user-1',
      domainBackend: false,
    });
  });

  it('allows explicit orgId/userId extras to override claims', () => {
    const request = makeRequest({
      accessTokenClaims: {
        userId: 'u',
        email: 'a@b.com',
        domain: 'app.example.com',
        clientId: 'c',
        role: 'user',
        org: { org_id: 'org-old', org_role: 'member', teams: [], team_roles: {} },
      },
    } as never);

    setTenantContextFromRequest(request, { orgId: 'org-new', userId: 'override' });

    expect(request.tenantContext).toEqual({
      domain: 'app.example.com',
      orgId: 'org-new',
      userId: 'override',
      domainBackend: false,
    });
  });

  it('coalesces missing org/user to null', () => {
    const request = makeRequest();
    setTenantContextFromRequest(request);
    expect(request.tenantContext).toEqual({
      domain: 'app.example.com',
      orgId: null,
      userId: null,
      domainBackend: false,
    });
  });

  it('throws when request.config.domain is missing', () => {
    const request = makeRequest({ config: undefined } as never);
    expect(() => setTenantContextFromRequest(request)).toThrow(
      /request\.config\.domain is not set/,
    );
  });

  // The flag is derived from the guard's decision and from nothing else:
  // `requireOrgRole` and `requireOrgBackendOnly` are the only writers of
  // `request.orgBackendCaller`, and both go through `acceptDomainBackendCaller`.
  it('marks domain-backend context when the guard accepted the domain pairing', () => {
    const request = makeRequest({
      orgBackendCaller: { domain: 'app.example.com' },
    } as never);

    setTenantContextFromRequest(request, { orgId: 'org-1' });

    expect(request.tenantContext).toEqual({
      domain: 'app.example.com',
      orgId: 'org-1',
      userId: null,
      domainBackend: true,
    });
  });

  // There is no override. A route cannot hand itself domain-wide visibility;
  // the only way to `app.domain_backend = 'on'` is through a guard that ran the
  // pairing checks. `GET /org/organisations` used to assert the flag directly,
  // and that is exactly how a blank forwarded token read the whole domain.
  it('leaves domain-backend context off when no guard set orgBackendCaller', () => {
    const request = makeRequest();

    setTenantContextFromRequest(request, { orgId: null });

    expect(request.tenantContext).toEqual({
      domain: 'app.example.com',
      orgId: null,
      userId: null,
      domainBackend: false,
    });
  });
});
