export const PUBLIC_ERROR_MESSAGE = 'Request failed';

// Brief 12: email tokens must be time-limited and one-time.
// TTL is implementation-defined; keep short by default.
export const EMAIL_TOKEN_TTL_MS = 30 * 60 * 1000;

// Brief 22.13: authorization codes must be short-lived (OAuth authorization code flow).
export const AUTHORIZATION_CODE_TTL_MS = 5 * 60 * 1000;

// Brief 13 / Phase 8.6: 2FA challenges during login must be short-lived bearer tokens.
export const TWOFA_CHALLENGE_TTL_MS = 5 * 60 * 1000;

// Two-factor enrollment setup tokens bridge setup -> initial TOTP verification.
export const TWOFA_SETUP_TTL_MS = 10 * 60 * 1000;

// Social OAuth state is signed and short-lived to limit replay window.
export const SOCIAL_STATE_TTL_MS = 10 * 60 * 1000;

// JWT `aud` claim for access tokens issued by this service.
export const ACCESS_TOKEN_AUDIENCE = 'uoa:access-token';

// Slack-style login (Phase 3b, design §4.3): a numeric sign-in code, hashed and stored like other
// VerificationToken rows, with a short TTL and a bounded attempt budget (login-code.service.ts).
export const LOGIN_CODE_TTL_MS = 10 * 60 * 1000;
export const LOGIN_CODE_MAX_ATTEMPTS = 5;

// Slack-style login (Phase 3b, design §4.3/§4.4): the `login_token` bridge JWT authorizes ONLY
// workspace selection for an already-verified user (same class as `twofa_token`) — never
// authentication by itself. JWT `aud` claim, mirroring ACCESS_TOKEN_AUDIENCE's fixed-audience shape.
export const LOGIN_SESSION_AUDIENCE = 'uoa:login-session';
export const LOGIN_SESSION_TTL_MS = 10 * 60 * 1000;
