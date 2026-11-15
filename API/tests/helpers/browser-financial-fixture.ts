import { generateKeyPairSync } from 'node:crypto';
import { Prisma, type PrismaClient } from '@prisma/client';
import { vi } from 'vitest';
import { smsPaidNumberFixture } from './sms-paid-number-fixture.js';
import { smsIds } from './sms-financial-fixture.js';
import { configureSyntheticStripeMode } from './stripe-mode-config.js';

/** Isolated synthetic live-mode wallet. The injected Stripe transport never contacts a provider. */
export async function browserFinancialFixture(prisma: PrismaClient) {
  vi.stubEnv('STRIPE_BILLING_ENABLED', 'true');
  vi.stubEnv('LEDGER_BILLING_BASE_URL', 'https://ledger.example.test');
  vi.stubEnv('UOA_SMS_COMMERCIAL_POLICY_VERSION', 'synthetic-policy');
  vi.stubEnv('UOA_SMS_MONTHLY_FEE_EUR', '7.25');
  vi.stubEnv('UOA_SMS_MESSAGE_MARKUP_BPS', '2700');
  vi.stubEnv('LEDGER_BILLING_APP_KEY', 'lk_browser_fixture_unused_collector');
  vi.stubEnv('LEDGER_BILLING_APP_KEY_ID', 'tk_browser_fixture_collector');
  vi.stubEnv('LEDGER_BILLING_ASSERTION_AUDIENCE', 'https://ledger.example.test');
  const pair = generateKeyPairSync('rsa', { modulusLength: 2048 }),
    kid = 'browser-collector-fixture';
  vi.stubEnv(
    'UOA_BILLING_ASSERTION_SIGNING_PRIVATE_JWK',
    JSON.stringify({ ...pair.privateKey.export({ format: 'jwk' }), kid }),
  );
  vi.stubEnv(
    'UOA_BILLING_ASSERTION_PUBLIC_JWKS_JSON',
    JSON.stringify({ keys: [{ ...pair.publicKey.export({ format: 'jwk' }), kid }] }),
  );
  const base = await smsPaidNumberFixture(prisma);
  configureSyntheticStripeMode('acct_SmsFixture', true);
  await prisma.$transaction(async (tx) => {
    // Opening fixture state only; admission, concurrency, release and settlement keep every guard enabled.
    await tx.$executeRawUnsafe('SET LOCAL session_replication_role = replica');
    await tx.$executeRaw(
      Prisma.sql`UPDATE billing_organisation_modes SET sandbox=false WHERE org_id=${smsIds.org}`,
    );
    await tx.$executeRaw(
      Prisma.sql`UPDATE billing_organisation_mode_events SET sandbox=false WHERE org_id=${smsIds.org}`,
    );
    await tx.$executeRaw(
      Prisma.sql`UPDATE billing_stripe_accounts SET livemode=true WHERE id=${smsIds.account}`,
    );
    await tx.$executeRaw(
      Prisma.sql`UPDATE billing_credit_accounts SET balance_microcredits=100000000000 WHERE id=${smsIds.credit}`,
    );
  });
  const credential = { ...base.lifecycle, id: 'browser-runtime', purpose: 'BROWSER_RUNTIME' as const };
  await prisma.billingAppKey.create({
    data: {
      id: credential.id,
      serviceId: smsIds.service,
      purpose: credential.purpose,
      name: 'Synthetic browser runtime',
      keyPrefix: credential.id,
      secretDigest: credential.id,
      actorIssuer: credential.actorIssuer,
      actorAudience: credential.actorAudience,
      actorKeyId: credential.actorKeyId,
      actorPublicJwk: credential.actorPublicJwk as Prisma.InputJsonValue,
    },
  });
  const project = 'a0000000-0000-4000-8000-000000000001';
  const policy = await prisma.billingBrowserPolicy.create({
    data: {
      serviceId: smsIds.service,
      projectId: project,
      providerUsdPerHour: '0.12',
      roundingSeconds: 60,
      sourceUrl: 'https://docs.browserbase.com/account/billing/plans',
      validUntil: new Date(Date.now() + 86_400_000),
      createdByUserId: smsIds.user,
    },
  });
  return {
    ...base,
    credential,
    project,
    policy,
    subject: { product: 'nessie', organisation_id: smsIds.org, team_id: smsIds.team, user_id: smsIds.user },
  };
}
