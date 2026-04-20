import { importJWK, SignJWT, type JWTPayload, type KeyLike } from 'jose';

export const TEST_SHARED_SECRET = 'test-shared-secret-with-enough-length';
export const TEST_AUTH_SERVICE_IDENTIFIER = 'uoa-auth-service';
export const TEST_CONFIG_JWKS_URL = 'https://auth.example.com/.well-known/jwks.json';
export const TEST_CONFIG_KID = 'test-config-key';

let testConfigKeyPairPromise:
  | Promise<{ privateKey: KeyLike; publicJwk: Record<string, unknown> }>
  | undefined;

const TEST_CONFIG_PRIVATE_JWK = {
  kty: 'RSA',
  n: 'uwOdJH_0TeS4T_DK54T6sF14YhjRbFKxTewz1_En5fHuDPVrpeeL16gNn52K7SGgOAAt-BbXCAa8OUbrXQcVTf64nopqeNmyXFo206gcclOg5lY94TB8NZJWZHQb_Ri3hzrav3VZZpcvkeT7noYSS6Eex0ZpaThNGMKhFaW6UTOqjX9cC_Hf3AvIVigLCc1Cjo9sK8nBNzYrPrQ0mh10Mvi1-HJfCDiuxxOXO9YkH_MGTCltcw70RswikkiLzQMsf22uwGiYRMvlO6ypa815D1PPt9DjBaSEmZjoyRrBYl_dMgMwaxlTuOJiVPkT0rAKI8zofi00Fm8VeA-3Y60jbw',
  e: 'AQAB',
  d: 'MrtrvTOS4DCcSV9eg8jgwshQeHgYE8UpASUC-WEbvDbRp6VKIxL5rjKSI4s23VZCYv61ebgkdDJzjCwvfCiIQITJq4SMFqWjy4bTmb5gnSkPnHynw7eF8nh0xEJ1N0clvmMaZVbdvkVkK7VNBveC7g5SzadNwDP8QivGTBuNvCoLr0Hlj0cON6Aqo3FwBUp98szqaHuJ4qDX6OTE5RXs2-R1p8kpiI7Ny4Dhv-y6x67azqgZU2O4tZf8qNNvwpmkDWoZUEp82yFtNkK2_eziIjxn6Bci0NzHJXFqDbfpKj8w-n5dh_be1m1jb9QXQsbIw9v6fj3_2WM87bXcR6G_9Q',
  p: '3ktcL8zPgElaClK-7BE_BXGiJezUEmnxtdmfX4HWUKUU3XzDRrMFNEYtGXenAx5Q2PDAH7pEHQ0bi8-6h-PNk401PA_7hCUbjHVTlELUTE-tyYmrImW8OvzxIktcuHjxi-hYmbRWfHxkxMfSrRGeeSCF9qOpKkwM8ZPNh44zl0M',
  q: '117OMoPak_LC_SrmYcuZuAPWe_xrt3t2ByvOHNs9yYn4AuZ4_8HNxw-PXS0R2hrb_bAJvfyvVh9zhHB9uJn8Nq0zsWLEBSk9IdLtSs2VASGOiWFuLPdClDZNr3qgF8i_Dxr6f3fwGAH9Y_5ogCgaXSiPl4eymPGoEQAWpKY1UmU',
  dp: 'E3guPtGFawsBo93TcwGfr25gcUno2SQGU5MX7lmE19NdnHiM8ehEEGwFDzH3osJI-nc7nIvH43N-ciRjhfthygaYHwaXVN-bJhYwl8-yoGxqIDi6kGywq8nzpLlNCasuHL7g47VzzbtnaATIYvgkFR_QG-YBrv6yM4ZqffDqe9k',
  dq: 'ZzD0qT2F-Edj5_urIQZ1o7arCQMb9XEBT1RM0IS3qR4jJ_iX1ytb1ln9Pg6_M_qUl4vGTzKILEKrjbR8eHvHXcdFMmP5OePVd6Rhr-qqzzzt16NIL-FVFECknkSp-ltkN--cQIEOF-K0LzoRhf4xC5vImTkaeK-o8GRTdRZyDAU',
  qi: 'xhwyfiv-SwghDzBCoOxW09W--_Bj_e27tgxF3EuEWcu6HrMRKNL25Zfjdff-Fo0WdvC5shaJWSwjaCfaJsuxgGBBCN5izGdZOQxlW-RKAd6Tsm1w4K8t84j_jRDsq1LeQoAfZqy24Ikx8kvHs6aRSyPx4lo0BTRC6v1UuF9Kz68',
};

const TEST_CONFIG_PUBLIC_JWK = {
  kty: 'RSA',
  n: TEST_CONFIG_PRIVATE_JWK.n,
  e: TEST_CONFIG_PRIVATE_JWK.e,
  kid: TEST_CONFIG_KID,
  alg: 'RS256',
  use: 'sig',
};

async function getTestConfigKeyPair(): Promise<{
  privateKey: KeyLike;
  publicJwk: Record<string, unknown>;
}> {
  testConfigKeyPairPromise ??= importJWK(TEST_CONFIG_PRIVATE_JWK, 'RS256').then(
    (privateKey) => ({
      privateKey,
      publicJwk: TEST_CONFIG_PUBLIC_JWK,
    }),
  );

  return testConfigKeyPairPromise;
}

export function testUiTheme(): Record<string, unknown> {
  return {
    colors: {
      bg: '#f8fafc',
      surface: '#ffffff',
      text: '#0f172a',
      muted: '#475569',
      primary: '#2563eb',
      primary_text: '#ffffff',
      border: '#e2e8f0',
      danger: '#dc2626',
      danger_text: '#ffffff',
    },
    radii: {
      card: '16px',
      button: '12px',
      input: '12px',
    },
    density: 'comfortable',
    typography: { font_family: 'sans', base_text_size: 'md' },
    button: { style: 'solid' },
    card: { style: 'bordered' },
    logo: { url: '', alt: 'Logo' },
  };
}

export function baseClientConfigPayload(
  overrides?: Record<string, unknown>,
): JWTPayload {
  return {
    domain: 'client.example.com',
    redirect_urls: ['https://client.example.com/oauth/callback'],
    enabled_auth_methods: ['email_password'],
    ui_theme: testUiTheme(),
    language_config: 'en',
    ...overrides,
  };
}

export async function testConfigJwks(): Promise<{ keys: Record<string, unknown>[] }> {
  const { publicJwk } = await getTestConfigKeyPair();
  return { keys: [publicJwk] };
}

export async function signTestConfigJwt(
  payload: JWTPayload = baseClientConfigPayload(),
  options?: {
    audience?: string | null;
    kid?: string;
  },
): Promise<string> {
  const { privateKey } = await getTestConfigKeyPair();
  const jwt = new SignJWT(payload).setProtectedHeader({
    alg: 'RS256',
    kid: options?.kid ?? TEST_CONFIG_KID,
    typ: 'JWT',
  });

  if (options?.audience !== null) {
    jwt.setAudience(
      options?.audience ?? process.env.AUTH_SERVICE_IDENTIFIER ?? TEST_AUTH_SERVICE_IDENTIFIER,
    );
  }

  return await jwt.sign(privateKey);
}

export async function createTestConfigFetchHandler(
  configResponses: string | Record<string, string>,
): Promise<(input: RequestInfo | URL) => Promise<Response>> {
  const jwks = await testConfigJwks();
  const jwksUrl = process.env.CONFIG_JWKS_URL ?? TEST_CONFIG_JWKS_URL;

  return async (input: RequestInfo | URL): Promise<Response> => {
    const url =
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;

    if (url === jwksUrl) {
      return new Response(JSON.stringify(jwks), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }

    const jwt =
      typeof configResponses === 'string' ? configResponses : configResponses[url];

    if (jwt) {
      return new Response(jwt, { status: 200 });
    }

    return new Response('', { status: 404 });
  };
}
