export type Connection = {
  id: string; preset: string; protocol: 'oidc' | 'saml'; display_name: string;
  status: string; revision: number; configuration: Record<string, unknown>;
  secret_configured: boolean; tested_revision: number | null;
  callback_url?: string; sp_entity_id?: string; acs_url?: string; metadata_url?: string;
  last_test?: { status: 'passed' | 'failed'; code: string | null; at: string } | null;
};
export type EmailDomain = {
  id: string; email_domain: string; status: string;
  challenge?: { name: string; value: string; expires_at: string };
  challenge_expires_at?: string;
};
export type AccessSettings = {
  org: { id: string; name: string }; client_domain: string; csrf_token: string;
  connections: Connection[]; domains: EmailDomain[];
  policy: { revision: number; enforcement: string; session_max_age_seconds: number; reauth_mode: string };
  readiness: { activation_allowed: boolean; enforcement_allowed: boolean; blockers: string[] };
  presets: { id: string; protocols: string[] }[]; scim: { enabled: boolean };
};
export class AccessError extends Error {
  constructor(public status: number) { super('Organisation access request failed'); }
}
const bad = (): never => { throw new AccessError(502); };
export const isRecord = (v: unknown): v is Record<string, unknown> =>
  Boolean(v) && typeof v === 'object' && !Array.isArray(v);
function object(value: unknown) { return isRecord(value) ? value : bad(); }
function string(value: unknown): string { return typeof value === 'string' ? value : bad(); }
function bool(value: unknown): boolean { return typeof value === 'boolean' ? value : bad(); }
function integer(value: unknown, minimum = 0): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= minimum ? value : bad();
}
function list(value: unknown): unknown[] { return Array.isArray(value) ? value : bad(); }
function choice<T extends string>(value: unknown, choices: readonly T[]): T {
  return choices.find((item) => item === value) ?? bad();
}
function timestamp(value: unknown): string {
  const text = string(value); return Number.isFinite(Date.parse(text)) ? text : bad();
}
function ownUrl(value: unknown): string {
  const text = string(value);
  try {
    const url = new URL(text);
    if (url.origin !== window.location.origin || url.username || url.password || url.hash) return bad();
    return text;
  } catch { return bad(); }
}
const protocols = ['oidc', 'saml'] as const;
const presets = ['entra', 'okta', 'google_workspace', 'keycloak', 'adfs', 'other_oidc', 'other_saml'] as const;
function configuration(value: unknown): Record<string, unknown> {
  const raw = object(value);
  for (const key of ['issuer', 'client_id', 'entity_id', 'sso_url', 'subject_attribute']) {
    if (raw[key] !== undefined) string(raw[key]);
  }
  if (raw.tenant !== undefined) {
    const tenant = object(raw.tenant); string(tenant.value);
    if (tenant.claim !== undefined) string(tenant.claim);
    if (tenant.attribute !== undefined) string(tenant.attribute);
  }
  if (raw.certificates !== undefined) list(raw.certificates).forEach(string);
  return raw;
}
function connection(value: unknown): Connection {
  const raw = object(value);
  const result: Connection = {
    id: string(raw.id), preset: choice(raw.preset, presets), protocol: choice(raw.protocol, protocols),
    display_name: string(raw.display_name), revision: integer(raw.revision, 1),
    status: choice(raw.status, ['draft', 'testing', 'active', 'disabled', 'suspended']),
    configuration: configuration(raw.configuration), secret_configured: bool(raw.secret_configured),
    tested_revision: raw.tested_revision === null ? null : integer(raw.tested_revision, 1),
  };
  for (const key of ['callback_url', 'acs_url', 'metadata_url'] as const) {
    if (raw[key] !== undefined) result[key] = ownUrl(raw[key]);
  }
  if (raw.sp_entity_id !== undefined) result.sp_entity_id = string(raw.sp_entity_id);
  if (raw.last_test !== undefined && raw.last_test !== null) {
    const test = object(raw.last_test);
    result.last_test = { status: choice(test.status, ['passed', 'failed']),
      code: test.code === null ? null : string(test.code), at: timestamp(test.at) };
  }
  return result;
}
function domain(value: unknown): EmailDomain {
  const raw = object(value);
  const result: EmailDomain = { id: string(raw.id), email_domain: string(raw.email_domain),
    status: choice(raw.status, ['PENDING', 'VERIFIED', 'EXPIRED', 'REVOKED', 'SUSPENDED']) };
  if (raw.challenge !== undefined) {
    const proof = object(raw.challenge);
    result.challenge = { name: string(proof.name), value: string(proof.value), expires_at: timestamp(proof.expires_at) };
  }
  if (raw.challenge_expires_at !== undefined) result.challenge_expires_at = timestamp(raw.challenge_expires_at);
  return result;
}
export function decodeSettings(value: unknown): AccessSettings {
  const raw = object(value); const org = object(raw.org); const policy = object(raw.policy);
  const readiness = object(raw.readiness); const scim = object(raw.scim);
  return {
    org: { id: string(org.id), name: string(org.name) }, client_domain: string(raw.client_domain),
    csrf_token: string(raw.csrf_token), connections: list(raw.connections).map(connection),
    domains: list(raw.domains).map(domain), policy: { revision: integer(policy.revision),
      enforcement: choice(policy.enforcement, ['off', 'required_for_verified_domains', 'required_for_all_members']),
      session_max_age_seconds: integer(policy.session_max_age_seconds, 1),
      reauth_mode: choice(policy.reauth_mode, ['detect_only', 'force']) },
    readiness: { activation_allowed: bool(readiness.activation_allowed),
      enforcement_allowed: bool(readiness.enforcement_allowed), blockers: list(readiness.blockers).map(string) },
    presets: list(raw.presets).map((value) => {
      const preset = object(value); const supported = list(preset.protocols).map((p) => choice(p, protocols));
      if (!supported.length) return bad();
      return { id: choice(preset.id, presets), protocols: supported };
    }), scim: { enabled: bool(scim.enabled) },
  };
}
