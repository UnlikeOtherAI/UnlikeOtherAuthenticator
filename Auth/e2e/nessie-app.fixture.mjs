import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

/** Two real applications, separate databases, and only an explicit HTTP fixture boundary. */
export async function nessieAppFixture(checkout, databaseUrl, transport) {
  if (!new URL(databaseUrl).pathname.startsWith('/nessie_sso_cross_app_')) {
    throw new Error('Cross-app evaluation requires its own explicitly named isolated database');
  }
  const require = createRequire(resolve(checkout, 'api/package.json'));
  const load = (path) => import(pathToFileURL(resolve(checkout, path)).href);
  const runtime = await load('packages/runtime/dist/index.js');
  const { loadConfig } = await load('packages/config/dist/index.js');
  const { PrismaClient } = require('@prisma/client');
  const Fastify = require('fastify');
  const undici = require('undici');
  const previousFetch = undici.fetch;
  undici.fetch = (url, init) => transport(new URL(url), init);
  const prisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
  await prisma.integratedProduct.upsert({ where: { slug: 'nessie' }, update: {}, create: {
    slug: 'nessie', name: 'Nessie', summary: 'Product fixture', category: 'development',
    authMode: 'uoa_sso', defaultInstallState: 'native', pluginManifestRef: 'first-party/nessie' } });
  const auth = await load('api/dist/services/uoa-auth.js');
  const { createSessionIssuers } = await load('api/dist/services/session-issuers.js');
  const { authorizeUoaRequest } = await load('api/dist/services/uoa-request-authorization.js');
  const { createRequestAdmission, getAuthorizationToken } = await load('api/dist/services/request-admission.js');
  const { registerGlobalAuthHook } = await load('api/dist/lib/global-auth-hook.js');
  const { registerAuthCoreRoutes } = await load('api/dist/routes/auth-core.js');
  const { registerAuthLoginRoute } = await load('api/dist/routes/auth-login.js');
  const { issueRefreshToken } = await load('api/dist/services/refresh-token.js');
  const config = loadConfig({ argv: [], env: { NESSIE_MODE: 'local' } });
  config.auth.providers = [{ providerId: 'uoa', type: 'uoa', enabled: true,
    label: 'Continue with UnlikeOtherAI', autoRedirect: false, scopes: [] }];
  config.auth.autoRedirectToSso = false;
  const encryption = 'cross-app-test-only-encryption';
  const authSecret = 'cross-app-test-only-session-secret';
  const uoaAssuranceResolver = runtime.createUoaAssuranceResolver(prisma, encryption);
  const settings = auth.loadUoaSettings();
  const upstream = { assuranceResolver: uoaAssuranceResolver,
    fetchImpl: transport, resolveHost: async () => ['93.184.216.34'] };
  const humanAuthority = runtime.createUoaHumanAdmission(prisma, { ...upstream,
    settings: { authBaseUrl: settings.baseUrl, sourceDomain: settings.domain,
      configUrl: settings.configUrl, clientSecret: settings.clientSecret,
      kid: settings.kid, privateKeyPem: settings.privateKeyPem } });
  const issuers = createSessionIssuers({ authSecret, defaultProviderType: 'local-bootstrap', prisma,
    tokenTtlSeconds: 600, authorizeUoaRequest: (org, identity) => authorizeUoaRequest(org, identity, upstream) });
  const authenticateRequest = createRequestAdmission({ config, prisma, authSecret, humanAuthority,
    getAuthorizationToken, isSessionRevokedById: async () => false, uoaDirectoryRefreshDeps: upstream,
    authorizeUoaRequest: (org, identity, scope) => authorizeUoaRequest(org, identity, { ...scope, ...upstream }) });
  const app = Fastify();
  const deps = { ...issuers, config, prisma, authSecret, authenticateRequest, getAuthorizationToken,
    humanAuthority, uoaAssuranceResolver, encryptionKeyRing: encryption,
    rateLimiter: { guard: async () => ({ allowed: true }) }, resolveBootstrapState: async () => null,
    fileService: null, ledgerIdentity: null, sharedModelClient: null,
    allowedCorsOrigins: ['https://app.example.com'], teamHostBaseDomain: null };
  registerGlobalAuthHook(app, deps);
  registerAuthCoreRoutes(app, deps, async () => {});
  registerAuthLoginRoute(app, deps, async (_request, _reply, input) => {
    assert.ok(input.uoaSession);
    const session = input.uoaSession;
    await issueRefreshToken(prisma, { ...input, encryption, ttlSeconds: 600, uoaSession: {
      configUrl: session.exchange.configUrl, identity: session.identity,
      assurance: session.exchange.assurance, refreshToken: session.exchange.refreshToken,
      refreshTokenExpiresAt: new Date(Date.now() + session.exchange.refreshTokenExpiresInSeconds * 1000) } });
  });
  await app.ready();
  return { app, prisma, auth, runtime, uoaAssuranceResolver,
    close: async () => { await app.close(); await prisma.$disconnect(); undici.fetch = previousFetch; } };
}
