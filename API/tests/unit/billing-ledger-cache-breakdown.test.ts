import { readFile } from 'node:fs/promises';
import { exportJWK, generateKeyPair } from 'jose';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { parseEnv, type Env } from '../../src/config/env.js';
import { LedgerMeteringPortfolioSchema } from '../../src/services/billing-ledger-metering-schema.service.js';
import { fetchLedgerMeteringPortfolio } from '../../src/services/billing-ledger-collector.service.js';

let base: ReturnType<typeof LedgerMeteringPortfolioSchema.parse>;
let env: Env;
beforeAll(async () => {
  base = LedgerMeteringPortfolioSchema.parse(JSON.parse(await readFile(
    new URL('../fixtures/ledger-metering-portfolio-v1.example.json', import.meta.url), 'utf8')));
  const pair = await generateKeyPair('RS256', { extractable: true });
  const privateJwk = await exportJWK(pair.privateKey), publicJwk = await exportJWK(pair.publicKey);
  for (const jwk of [privateJwk, publicJwk]) Object.assign(jwk, { kid: 'synthetic-cache-breakdown', alg: 'RS256', use: 'sig' });
  env = parseEnv({ NODE_ENV: 'test', HOST: '127.0.0.1', PORT: '3000', SHARED_SECRET: 'synthetic-cache-breakdown-secret',
    PUBLIC_BASE_URL: 'https://authentication.unlikeotherai.com', AUTH_SERVICE_IDENTIFIER: 'authentication.unlikeotherai.com',
    LEDGER_BILLING_BASE_URL: 'https://ledger.unlikeotherai.com', LEDGER_BILLING_APP_KEY: 'lk_synthetic_cache_breakdown',
    LEDGER_BILLING_APP_KEY_ID: 'tk_synthetic_cache_breakdown', LEDGER_BILLING_ASSERTION_AUDIENCE: 'https://ledger.unlikeotherai.com',
    UOA_BILLING_ASSERTION_SIGNING_PRIVATE_JWK: JSON.stringify(privateJwk),
    UOA_BILLING_ASSERTION_PUBLIC_JWKS_JSON: JSON.stringify({ keys: [publicJwk] }) });
});

function envelope(fields: Record<string, unknown>) {
  const value = structuredClone(base);
  const target = value.totals.usageByService[0]!.rawProviderUsage;
  const line = value.breakdown[0]!.rawProviderUsage;
  Object.assign(target, { breakdown: fields }); Object.assign(line, { breakdown: fields });
  return value;
}
describe('strict Ledger cache-write breakdown compatibility', () => {
  it('accepts the two actual producer fields in totals and breakdown and preserves exact integer facts', async () => {
    const breakdown = { cacheWrite30mTokens: '17', cacheWrite12hTokens: '9007199254740993' };
    const response = envelope(breakdown);
    const normalized = await fetchLedgerMeteringPortfolio({ product: base.perspectiveProduct,
      organisationId: base.scope.organizationId, teamId: base.scope.teamId, billingMonth: base.scope.month,
      groupBy: base.groupBy }, { env, fetch: vi.fn().mockResolvedValue(new Response(JSON.stringify(response), { status: 200 })) });
    expect(normalized.lines[0]?.breakdown).toMatchObject(breakdown);
    expect(normalized.scope).toEqual(base.scope);
    expect(normalized.snapshot.sha256).toMatch(/^[a-f0-9]{64}$/);
  });
  it.each(['cacheWrite30mTokens', 'cacheWrite12hTokens'])('requires unsigned decimal integer strings for %s', field => {
    for (const value of ['0', '1', '9007199254740993']) {
      expect(LedgerMeteringPortfolioSchema.safeParse(envelope({ [field]: value })).success).toBe(true);
    }
    for (const value of ['-1', '1.5', '1e3', 17, null, {}]) {
      expect(LedgerMeteringPortfolioSchema.safeParse(envelope({ [field]: value })).success).toBe(false);
    }
  });
  it('still rejects unknown provider fields and financial/commercial injection', () => {
    for (const fields of [{ cacheWrite8hTokens: '1' }, { customerTotalDue: '0' }]) {
      expect(LedgerMeteringPortfolioSchema.safeParse(envelope(fields)).success).toBe(false);
    }
  });
});
