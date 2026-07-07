/**
 * Thin typed wrapper over fetch for the Auth SPA.
 *
 * The auth API returns either the expected JSON payload (2xx) or a generic
 * `{ error: 'Request failed' }` envelope. Some flows may also include a small
 * allowlisted machine-readable `code` so callers can pick the right i18n key.
 */

export type ApiSuccess<T> = {
  ok: true;
  status: number;
  data: T;
};

export type ApiFailure = {
  ok: false;
  status: number;
  /** The generic error string from `{ error }` if present, otherwise null. */
  error: string | null;
  /** Machine-readable public error code when the API intentionally exposes one. */
  code: string | null;
};

export type ApiResult<T> = ApiSuccess<T> | ApiFailure;

export type QueryValue = string | number | boolean | null | undefined;

function appendQuery(url: URL, query?: Record<string, QueryValue>): void {
  if (!query) return;
  for (const [key, value] of Object.entries(query)) {
    if (value === null || value === undefined) continue;
    url.searchParams.set(key, String(value));
  }
}

function buildUrl(path: string, query?: Record<string, QueryValue>): string {
  // Paths are always relative to the auth origin — the SPA lives in the
  // popup served by the same host as the API. Reject absolute URLs so a
  // stray `https://attacker.example/...` value can never bypass the base.
  if (path.startsWith('http://') || path.startsWith('https://') || path.startsWith('//')) {
    throw new Error('Absolute URLs not permitted');
  }
  const url = new URL(path, window.location.origin);
  appendQuery(url, query);
  return url.toString();
}

function extractError(body: unknown): string | null {
  if (body && typeof body === 'object' && 'error' in body) {
    const e = (body as Record<string, unknown>).error;
    if (typeof e === 'string') return e;
  }
  return null;
}

function extractCode(body: unknown): string | null {
  if (body && typeof body === 'object' && 'code' in body) {
    const code = (body as Record<string, unknown>).code;
    if (typeof code === 'string') return code;
  }
  return null;
}

async function parseJsonSafe(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

async function request<T>(
  method: 'GET' | 'POST',
  path: string,
  options: {
    query?: Record<string, QueryValue>;
    body?: unknown;
  } = {},
): Promise<ApiResult<T>> {
  const url = buildUrl(path, options.query);

  let response: Response;
  try {
    response = await fetch(url, {
      method,
      headers: {
        accept: 'application/json',
        ...(options.body !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
    });
  } catch {
    return { ok: false, status: 0, error: null, code: null };
  }

  const json = await parseJsonSafe(response);

  if (!response.ok) {
    return {
      ok: false,
      status: response.status,
      error: extractError(json),
      code: extractCode(json),
    };
  }

  return { ok: true, status: response.status, data: json as T };
}

export function getJson<TRes>(
  path: string,
  query?: Record<string, QueryValue>,
): Promise<ApiResult<TRes>> {
  return request<TRes>('GET', path, { query });
}

export function postJson<TReq, TRes>(
  path: string,
  body: TReq,
  query?: Record<string, QueryValue>,
): Promise<ApiResult<TRes>> {
  return request<TRes>('POST', path, { query, body });
}

/**
 * Phase 3c (design §11.2): the query parameters every `/auth/*` flow endpoint needs — the
 * same shape `LoginForm`/`RegisterForm` build inline, pulled out so the code-entry and
 * workspace-chooser calls can share it.
 */
export type AuthFlowQuery = {
  configUrl: string;
  redirectUrl?: string | null;
  codeChallenge?: string | null;
  codeChallengeMethod?: 'S256' | null;
  requestAccess?: boolean;
};

function buildAuthFlowQuery(params: AuthFlowQuery): Record<string, QueryValue> {
  const query: Record<string, QueryValue> = { config_url: params.configUrl };
  if (params.redirectUrl) query.redirect_url = params.redirectUrl;
  if (params.codeChallenge && params.codeChallengeMethod) {
    query.code_challenge = params.codeChallenge;
    query.code_challenge_method = params.codeChallengeMethod;
  }
  if (params.requestAccess) query.request_access = true;
  return query;
}

export type AuthStartRequest = { email: string };
export type AuthStartResponse = { message: string };

/** POST /auth/start — Slack-style email-first entry point (Phase 3b). */
export function authStart(
  body: AuthStartRequest,
  query: AuthFlowQuery,
): Promise<ApiResult<AuthStartResponse>> {
  return postJson<AuthStartRequest, AuthStartResponse>(
    '/auth/start',
    body,
    buildAuthFlowQuery(query),
  );
}

export type VerifyLoginCodeRequest = {
  email: string;
  code: string;
  remember_me?: boolean;
};

/**
 * The three shapes `/auth/verify-code`, `/auth/select-team`, and a chooser-producing
 * `/auth/login` can all resolve to (mirrors the Phase 3b API route bodies field-for-field —
 * see `auth-verify-code.ts` / `auth-select-team.ts`). The chooser payload has no `ok` field.
 */
export type WorkspaceChooserResponse = {
  login_token: string;
  teams: unknown[];
  pending_invites: unknown[];
  can_create_org: boolean;
};

export type TwoFaRequiredResponse = {
  ok: true;
  twofa_required: true;
  twofa_token: string;
};

export type TwoFaEnrollRequiredResponse = {
  ok: true;
  twofa_enroll_required: true;
  setup_token: string;
  otpauth_uri?: string;
  qr_svg?: string;
  manual_secret?: string;
};

export type AuthFlowFinalResponse = {
  ok: true;
  code?: string;
  redirect_to?: string;
  access_request_status?: 'pending';
};

export type AuthFlowResponse =
  | WorkspaceChooserResponse
  | TwoFaRequiredResponse
  | TwoFaEnrollRequiredResponse
  | AuthFlowFinalResponse;

/** POST /auth/verify-code — verify an emailed 6-digit sign-in code (Phase 3b). */
export function verifyLoginCode(
  body: VerifyLoginCodeRequest,
  query: AuthFlowQuery,
): Promise<ApiResult<AuthFlowResponse>> {
  return postJson<VerifyLoginCodeRequest, AuthFlowResponse>(
    '/auth/verify-code',
    body,
    buildAuthFlowQuery(query),
  );
}

export type SelectTeamRequest = {
  login_token: string;
  teamId?: string;
  inviteId?: string;
  action?: 'accept' | 'decline';
  remember_me?: boolean;
};

/** POST /auth/select-team — choose a workspace or accept/decline an invite (Phase 3b). */
export function selectTeam(
  body: SelectTeamRequest,
  query: AuthFlowQuery,
): Promise<ApiResult<AuthFlowResponse>> {
  return postJson<SelectTeamRequest, AuthFlowResponse>(
    '/auth/select-team',
    body,
    buildAuthFlowQuery(query),
  );
}
