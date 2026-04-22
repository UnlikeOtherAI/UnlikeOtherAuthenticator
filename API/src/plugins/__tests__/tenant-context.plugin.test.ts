import type { FastifyRequest } from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';

const getPrismaMock = vi.hoisted(() => vi.fn());
const getAdminPrismaMock = vi.hoisted(() => vi.fn());
const runWithContextMock = vi.hoisted(() => vi.fn());

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
  afterEach(() => {
    getPrismaMock.mockReset();
    getAdminPrismaMock.mockReset();
    runWithContextMock.mockReset();
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

  it('withTenantTx delegates to runWithTenantContext with the request context', async () => {
    const tenantClient = { id: 'tenant' };
    getPrismaMock.mockReturnValue(tenantClient);
    getAdminPrismaMock.mockReturnValue({});
    runWithContextMock.mockImplementation(async (_opts, handler) => handler({ tx: true }));

    const harness = makeApp();
    await harness.register();

    const request = makeRequest({
      tenantContext: { domain: 'app.example.com', orgId: 'org-1', userId: 'user-1' },
    } as never);
    const hook = harness.hook;
    if (!hook) throw new Error('onRequest hook not registered');
    await hook(request);

    const result = await request.withTenantTx(async (tx) => tx);
    expect(result).toEqual({ tx: true });
    expect(runWithContextMock).toHaveBeenCalledWith(
      {
        prisma: tenantClient,
        context: { domain: 'app.example.com', orgId: 'org-1', userId: 'user-1' },
      },
      expect.any(Function),
    );
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
    });
  });

  it('coalesces missing org/user to null', () => {
    const request = makeRequest();
    setTenantContextFromRequest(request);
    expect(request.tenantContext).toEqual({
      domain: 'app.example.com',
      orgId: null,
      userId: null,
    });
  });

  it('throws when request.config.domain is missing', () => {
    const request = makeRequest({ config: undefined } as never);
    expect(() => setTenantContextFromRequest(request)).toThrow(
      /request\.config\.domain is not set/,
    );
  });
});
