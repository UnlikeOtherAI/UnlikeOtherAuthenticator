/** In-memory organisation wallets and platform credit grants for Admin e2e. */
const path = /^\/billing\/organisations\/([^/]+)\/credit-grants$/;
const MICRO_PER_CREDIT = 1_000_000n;

function amount(microcredits: bigint) {
  const credits = microcredits / MICRO_PER_CREDIT;
  const usd = `${microcredits / 1_000_000_000n}${microcredits % 1_000_000_000n === 0n ? ''
    : `.${(microcredits % 1_000_000_000n).toString().padStart(9, '0').replace(/0+$/, '')}`}`;
  return { microcredits: microcredits.toString(), credits: credits.toString(), usd };
}

type Grant = { id: string; credit_entry_id: string; amount: ReturnType<typeof amount>; reason: string;
  granted_by: string; granted_at: string; mode: 'live' | 'sandbox' };

export function createCreditGrantFixtures(names: (orgId: string) => string | undefined) {
  const balances = new Map<string, bigint>();
  const grants = new Map<string, Grant[]>();
  const writes: Array<{ orgId: string; body: Record<string, unknown> }> = [];
  const refusals: Array<{ status: number; code: string }> = [];

  function read(orgId: string, name: string) {
    const balance = balances.get(orgId) ?? 0n;
    return { organisation: { id: orgId, name }, mode: 'live', credit_account_id: balances.has(orgId) ? `wallet-${orgId}` : null,
      balance: { confirmed: amount(balance), reserved: amount(0n), spendable: amount(balance) },
      limits: { max_credits: '10000000', reason_min: 12, reason_max: 500 },
      grants: grants.get(orgId) ?? [], has_more: false };
  }

  /** The response for a credit-grant request, or null when the path is not one. */
  function handle(method: string, requestPath: string, body: unknown): { status: number; body: unknown } | null {
    const match = path.exec(requestPath);
    if (!match?.[1]) return null;
    const orgId = match[1];
    const name = names(orgId);
    if (!name) return { status: 404, body: { error: 'Not found', code: 'BILLING_ORGANISATION_NOT_AVAILABLE' } };
    if (method === 'GET') return { status: 200, body: read(orgId, name) };
    if (method !== 'POST') return null;
    const input = body as Record<string, unknown>;
    writes.push({ orgId, body: input });
    const refusal = refusals.shift();
    if (refusal) return { status: refusal.status, body: { error: 'Refused', code: refusal.code } };
    if (typeof input.credits !== 'string' || !/^[1-9]\d{0,7}$/.test(input.credits)
      || typeof input.reason !== 'string' || input.reason.trim().length < 12
      || typeof input.idempotency_key !== 'string' || !/^[a-f0-9]{64}$/.test(input.idempotency_key)) {
      return { status: 400, body: { error: 'Invalid grant' } };
    }
    const micro = BigInt(input.credits) * MICRO_PER_CREDIT;
    const after = (balances.get(orgId) ?? 0n) + micro;
    balances.set(orgId, after);
    const grant: Grant = { id: `grant-${writes.length}`, credit_entry_id: `entry-${writes.length}`,
      amount: amount(micro), reason: input.reason.trim(), granted_by: 'operator@example.test',
      granted_at: new Date().toISOString(), mode: 'live' };
    grants.set(orgId, [grant, ...(grants.get(orgId) ?? [])]);
    return { status: 201, body: { grant, replayed: false, balance_after: amount(after) } };
  }

  return { handle, writes, refuseNext: (status: number, code: string) => { refusals.push({ status, code }); } };
}
