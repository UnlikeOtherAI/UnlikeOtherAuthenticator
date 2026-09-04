import { createHmac, randomUUID } from 'node:crypto';
import { z } from 'zod';

import { getEnv } from '../config/env.js';
import { AppError } from '../utils/errors.js';

const MAX_RESPONSE_BYTES = 1024 * 1024;
const CONTROL_PATH = '/api/internal/uoa/automatic-membership/control';

const scopeSchema = z.enum(['organisation', 'team']);
const actionSchema = z.enum([
  'list',
  'teams',
  'create',
  'update',
  'verify',
  'rotate',
  'activate',
  'suspend',
  'revoke',
  'release',
]);

const targetSchema = z.object({ external_team_id: z.string().min(1), name: z.string().min(1) }).strict();
const ruleSchema = z.object({
  id: z.string().min(1),
  domain: z.string().min(1),
  scope: scopeSchema,
  external_team_id: z.string().min(1).nullable(),
  state: z.enum(['pending', 'verified', 'active', 'suspended', 'revoked', 'rotating']),
  notification_email: z.string().email().nullable(),
  team_ids: z.array(z.string().min(1)),
  dns: z.object({ record_name: z.string().min(1), record_value: z.string().min(1) }).nullable(),
  last_check_at: z.string().datetime().nullable(),
  last_check_error: z.string().max(500).nullable(),
  verification_expires_at: z.string().datetime().nullable(),
  backfill: z.object({ status: z.string().min(1), processed: z.number().int().nonnegative(), granted: z.number().int().nonnegative(), failed: z.number().int().nonnegative(), error: z.string().max(500).nullable() }).nullable(),
}).strict();
const auditSchema = z.object({ id: z.string().min(1), action: z.string().min(1), created_at: z.string().datetime(), detail: z.string().max(1000).nullable() }).strict();
const controlResponseSchema = z.object({
  rules: z.array(ruleSchema).optional(),
  teams: z.array(targetSchema).optional(),
  rule: ruleSchema.optional(),
  audit: z.array(auditSchema).max(100).optional(),
  message: z.string().max(500).optional(),
}).strict();

export type AutomaticMembershipControlAction = z.infer<typeof actionSchema>;
export type AutomaticMembershipScope = z.infer<typeof scopeSchema>;
export type AutomaticMembershipControlResponse = z.infer<typeof controlResponseSchema>;

export type AutomaticMembershipControlRequest = {
  uoaActorSub: string;
  externalOrgId: string;
  externalTeamId?: string;
  scope: AutomaticMembershipScope;
  action: AutomaticMembershipControlAction;
  payload?: Record<string, unknown>;
};

function controlUrl(raw: string): URL {
  const base = new URL(raw);
  if (base.protocol !== 'https:' || base.username || base.password || base.search || base.hash) {
    throw new AppError('INTERNAL', 500, 'AUTOMATIC_MEMBERSHIP_CONTROL_CONFIGURATION_INVALID');
  }
  return new URL(CONTROL_PATH, `${base.toString().replace(/\/$/, '')}/`);
}

async function readBoundedJson(response: Response): Promise<unknown> {
  const length = response.headers.get('content-length');
  if (length && /^\d+$/.test(length) && BigInt(length) > BigInt(MAX_RESPONSE_BYTES)) {
    throw new AppError('INTERNAL', 502, 'AUTOMATIC_MEMBERSHIP_CONTROL_RESPONSE_TOO_LARGE');
  }
  if (!response.body) return {};
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const next = await reader.read();
    if (next.done) break;
    if (!next.value) continue;
    size += next.value.byteLength;
    if (size > MAX_RESPONSE_BYTES) {
      await reader.cancel();
      throw new AppError('INTERNAL', 502, 'AUTOMATIC_MEMBERSHIP_CONTROL_RESPONSE_TOO_LARGE');
    }
    chunks.push(next.value);
  }
  const data = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    data.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(data)) as unknown;
  } catch {
    throw new AppError('INTERNAL', 502, 'AUTOMATIC_MEMBERSHIP_CONTROL_RESPONSE_INVALID');
  }
}

/**
 * Calls Nessie from UOA's trusted server boundary. The Admin browser only talks
 * to UOA and never learns the bridge secret or an internal Nessie URL.
 */
export async function controlNessieAutomaticMembership(
  input: AutomaticMembershipControlRequest,
  deps: { fetch?: typeof fetch; now?: () => number; requestId?: () => string } = {},
): Promise<AutomaticMembershipControlResponse> {
  const env = getEnv();
  if (!env.NESSIE_UOA_AUTOMATIC_MEMBERSHIP_CONTROL_URL || !env.NESSIE_UOA_AUTOMATIC_MEMBERSHIP_CONTROL_SECRET) {
    throw new AppError('NOT_FOUND', 404, 'AUTOMATIC_MEMBERSHIP_CONTROL_NOT_CONFIGURED');
  }
  const requestId = deps.requestId?.() ?? randomUUID();
  const timestamp = String(deps.now?.() ?? Date.now());
  const scope = scopeSchema.parse(input.scope);
  const action = actionSchema.parse(input.action);
  const body = JSON.stringify({
    request_id: requestId,
    uoa_actor_sub: input.uoaActorSub,
    external_org_id: input.externalOrgId,
    ...(input.externalTeamId ? { external_team_id: input.externalTeamId } : {}),
    scope,
    action,
    payload: input.payload ?? {},
  });
  const signature = createHmac('sha256', env.NESSIE_UOA_AUTOMATIC_MEMBERSHIP_CONTROL_SECRET)
    .update(`${timestamp}.${body}`, 'utf8').digest('hex');
  let response: Response;
  try {
    response = await (deps.fetch ?? fetch)(controlUrl(env.NESSIE_UOA_AUTOMATIC_MEMBERSHIP_CONTROL_URL), {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(5_000),
      headers: { 'content-type': 'application/json', 'x-uoa-automatic-membership-timestamp': timestamp, 'x-uoa-automatic-membership-signature': signature, 'x-uoa-automatic-membership-request-id': requestId },
      body,
    });
  } catch {
    throw new AppError('INTERNAL', 502, 'AUTOMATIC_MEMBERSHIP_CONTROL_UNAVAILABLE');
  }
  if (!response.ok || response.redirected) {
    throw new AppError('INTERNAL', 502, 'AUTOMATIC_MEMBERSHIP_CONTROL_REJECTED');
  }
  try {
    return controlResponseSchema.parse(await readBoundedJson(response));
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError('INTERNAL', 502, 'AUTOMATIC_MEMBERSHIP_CONTROL_RESPONSE_INVALID');
  }
}
