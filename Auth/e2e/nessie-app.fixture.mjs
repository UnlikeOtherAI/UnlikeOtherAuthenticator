import { Agent, get } from 'node:http';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { constants, runInThisContext } from 'node:vm';

// Load the other repository's actual Node build outside Vitest's source transform graph.
const nativeImport = runInThisContext('(url) => import(url)', {
  importModuleDynamically: constants.USE_MAIN_CONTEXT_DEFAULT_LOADER,
});
export const loadNessieBuild = (checkout, path) => nativeImport(pathToFileURL(resolve(checkout, path)).href);

/** Two real applications, separate databases, and only an explicit HTTP fixture boundary. */
export async function nessieAppFixture(checkout, databaseUrl, transport) {
  if (!new URL(databaseUrl).pathname.startsWith('/nessie_sso_cross_app_')) {
    throw new Error('Cross-app evaluation requires its own explicitly named isolated database');
  }
  const require = createRequire(resolve(checkout, 'api/package.json'));
  const load = (path) => loadNessieBuild(checkout, path);
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
  const { registerAuthRoutes } = await load('api/dist/routes/auth.js');
  const { registerTenantHostRoutes } = await load('api/dist/routes/tenant-hosts.js');
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
  await app.register(require('@fastify/cookie'));
  const deps = { ...issuers, config, prisma, authSecret, authenticateRequest, getAuthorizationToken,
    humanAuthority, uoaAssuranceResolver, encryptionKeyRing: encryption,
    rateLimiter: { guard: async () => ({ allowed: true }) }, resolveBootstrapState: async () => null,
    fileService: null, ledgerIdentity: null, sharedModelClient: null,
    allowedCorsOrigins: new Set(['https://app.example.com']), teamHostBaseDomain: null,
    parseHeaderValue: value => Array.isArray(value) ? value[0]?.trim() : typeof value === 'string' ? value.trim() : undefined };
  registerGlobalAuthHook(app, deps);
  registerAuthRoutes(app, deps);
  registerTenantHostRoutes(app, deps, upstream, upstream);
  app.get('/api/brand/logo', { config: { public: true } }, (_request, reply) => reply.code(404).send());
  await app.ready();
  return { app, prisma, auth, runtime, uoaAssuranceResolver,
    close: async () => { await app.close(); await prisma.$disconnect(); undici.fetch = previousFetch; } };
}

// Routed browser modules otherwise create unlimited parallel Node connections.
// Keep the local asset transport within the browser's ordinary connection budget.
const assetAgent = new Agent({ keepAlive: true, maxSockets: 8 });
export const closeNessieAssetTransport = () => assetAgent.destroy();
export const readNessieAsset = (url) => new Promise((resolve, reject) => {
  const request = get(url, { agent: assetAgent }, response => {
    const chunks = [];
    response.on('data', chunk => chunks.push(chunk));
    response.once('error', reject);
    response.once('end', () => resolve({ status: response.statusCode,
      headers: response.headers, body: Buffer.concat(chunks) }));
  });
  request.once('error', reject);
});
