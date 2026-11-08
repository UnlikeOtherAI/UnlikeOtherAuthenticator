import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import { CompactSign, exportJWK, generateKeyPair, jwtVerify } from 'jose';

/** Synthetic loopback Ledger producer. Real collector parsing, service assertion,
 * signed paid proof and exact UOA persisted-cohort matching all remain enabled. */
export async function startTeamReaderLedger(db: PrismaClient, uoaBase: string) {
  const service = await generateKeyPair('RS256', { extractable: true });
  const ledger = await generateKeyPair('RS256'), kid = 'owned-ledger-reader';
  const jwks = { keys: [{ ...await exportJWK(ledger.publicKey), kid, alg: 'RS256', use: 'sig' }] };
  let base = '', failure = false;
  const server = createServer(async (request, response) => {
    try {
      if (request.url === '/.well-known/jwks.json') { response.end(JSON.stringify(jwks)); return; }
      if (failure) { response.writeHead(503); response.end('{}'); return; }
      const { payload } = await jwtVerify(String(request.headers['x-uoa-service-assertion']), service.publicKey,
        { algorithms: ['RS256'], audience: base, issuer: uoaBase, subject: 'uoa-metering-reader' });
      if (request.headers['x-ledger-app-key'] !== 'owned-local-ledger-reader' || payload.scope !== 'metering.read' ||
        payload.azp !== 'owned-reader' || payload.product !== 'nessie' || payload.organization_id !== 'control-org' ||
        !['control-team', 'addon-other-team'].includes(String(payload.team_id))) throw Error('SCOPE_REFUSED');
      const teamId = String(payload.team_id), month = String(payload.billing_month), now = new Date().toISOString();
      const rows = await db.billingPaidUsageLiability.findMany({ where: { serviceId: 'control-service',
        orgId: 'control-org', teamId, billingMonth: month }, orderBy: { dispatchId: 'asc' } });
      response.setHeader('content-type', 'application/json');
      if (request.url?.startsWith('/v1/metering/paid-receipt-set')) {
        const digest = createHash('sha256').update('ledger-paid-receipt-set-v1:paid\n');
        for (const row of rows) digest.update(JSON.stringify([row.dispatchId, row.receiptId, row.rawCostActual.toFixed(18)])).update('\n');
        const body = { contract: 'ledger-paid-receipt-set-v1', scope: { billing_product: 'nessie',
          organization_id: 'control-org', team_id: teamId, billing_month: month }, snapshot: {
          cursor: `mpr_${'r'.repeat(32)}`, captured_at: now, immutable: true }, paid_receipt_count: String(rows.length),
        paid_receipt_sha256: digest.digest('hex'), zero_incremental_count: '0',
        zero_incremental_sha256: createHash('sha256').update('ledger-paid-receipt-set-v1:zero\n').digest('hex'), unresolved_paid_attempts: '0' };
        const signature = await new CompactSign(Buffer.from(JSON.stringify(body))).setProtectedHeader({ alg: 'RS256',
          typ: 'ledger-paid-receipt-set+jws', kid }).sign(ledger.privateKey);
        response.end(JSON.stringify({ ...body, signature })); return;
      }
      if (!request.url?.startsWith('/v1/metering/usage')) throw Error('VIEW_REFUSED');
      const start = new Date(`${month}-01T00:00:00Z`), end = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 1));
      const lines = rows.map(row => ({ serviceId: row.providerServiceId, usageUnit: 'tokens', calls: '1',
        rawProviderUsage: { unitsIn: '1', unitsCachedIn: '0', unitsOut: '1' }, billingProduct: 'nessie', callerProduct: 'nessie',
        originProduct: 'nessie', dimension: 'control-owner', billingDisposition: 'paid', costProvenance: 'actual',
        rawProviderCurrency: 'USD', rawProviderEstimatedCost: null, rawProviderActualCost: row.rawCostActual.toFixed(),
        rawProviderSelectedCost: row.rawCostActual.toFixed() }));
      response.end(JSON.stringify({ schemaVersion: 1, product: 'nessie', groupBy: 'user', scope: {
        organizationId: 'control-org', teamId, userId: null, month, startsAt: start.toISOString(), endsAt: end.toISOString() },
      totals: { calls: String(rows.length), usageByService: [], costs: [] }, breakdown: lines,
      billingCompleteness: { state: 'complete', unresolvedPaidAttempts: '0' }, snapshot: {
        cursor: `mus_${'s'.repeat(32)}`, id: `mus_${'s'.repeat(32)}`, capturedAt: now, immutable: true } }));
    } catch { response.writeHead(400); response.end('{}'); }
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); if (!address || typeof address === 'string') throw Error('LOOPBACK_REQUIRED');
  base = `http://127.0.0.1:${address.port}`;
  return { env: { LEDGER_BILLING_BASE_URL: base, LEDGER_BILLING_APP_KEY: 'owned-local-ledger-reader',
    LEDGER_BILLING_APP_KEY_ID: 'owned-reader', LEDGER_BILLING_ASSERTION_AUDIENCE: base,
    UOA_BILLING_ASSERTION_SIGNING_PRIVATE_JWK: JSON.stringify({ ...await exportJWK(service.privateKey), kid: 'owned-uoa-reader', alg: 'RS256' }),
    UOA_BILLING_ASSERTION_PUBLIC_JWKS_JSON: JSON.stringify({ keys: [{ ...await exportJWK(service.publicKey), kid: 'owned-uoa-reader', alg: 'RS256' }] }) },
  fail: (value: boolean) => { failure = value; },
  close: () => new Promise<void>((resolve, reject) => { server.close(error => error ? reject(error) : resolve()); server.closeAllConnections(); }) };
}
