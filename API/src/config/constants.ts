export const PUBLIC_ERROR_MESSAGE = 'Request failed';

// Brief 12: email tokens must be time-limited and one-time.
// TTL is implementation-defined; keep short by default.
export const EMAIL_TOKEN_TTL_MS = 30 * 60 * 1000;

// Brief 22.13: authorization codes must be short-lived (OAuth authorization code flow).
export const AUTHORIZATION_CODE_TTL_MS = 5 * 60 * 1000;

// Social OAuth state is signed and short-lived to limit replay window.
export const SOCIAL_STATE_TTL_MS = 10 * 60 * 1000;
