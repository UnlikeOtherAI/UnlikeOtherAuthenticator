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
// team selection for an already-verified user (same class as `twofa_token`) — never
// authentication by itself. JWT `aud` claim, mirroring ACCESS_TOKEN_AUDIENCE's fixed-audience shape.
export const LOGIN_SESSION_AUDIENCE = 'uoa:login-session';
export const LOGIN_SESSION_TTL_MS = 10 * 60 * 1000;

// Docs/Auth/avatars.md §3: uploaded avatars are raster-only (PNG/JPEG/WebP, magic-byte sniffed)
// and hard-capped at 1 MiB. Enforced after the multipart buffer is read, independently of the
// global @fastify/multipart fileSize limit, which is tuned for signature PDFs.
export const AVATAR_MAX_BYTES = 1024 * 1024;

// Docs/Auth/avatars.md §6: provider avatar URLs are proxied server-side so callers always get
// image bytes. The fetch is HTTPS-only, SSRF-guarded, time-capped and size-capped; any failure
// falls back to the generated avatar rather than surfacing an error.
//
// The budget is a deadline for the WHOLE operation — DNS resolution, every sequential address
// attempt, the fetch, and the streamed read — not a per-leg timeout. The URL is attacker-supplied,
// so a per-leg bound would let a host multiply the legs (slow DNS, then N addresses each stalling
// just under the cap) to occupy a request far longer than the number below suggests.
export const AVATAR_PROVIDER_DEADLINE_MS = 5_000;
export const AVATAR_PROVIDER_MAX_BYTES = 5 * 1024 * 1024;

// The TOTP QR logo URL comes from the signed client config (ui_theme.logo.url), so its publisher
// controls the DNS for it. The fetch is SSRF-guarded, pinned to a resolved address, time-capped
// and size-capped exactly like the provider-avatar fetch above — only tighter, because a QR logo
// never needs more than a few hundred KB.
export const TOTP_QR_LOGO_DEADLINE_MS = 5_000;
export const TOTP_QR_LOGO_MAX_BYTES = 1024 * 1024;

// Cache lifetimes for avatar GET responses. Generated avatars are deterministic for a given
// user/style/size, so they get a long private lifetime; uploaded and proxied images can change.
export const AVATAR_DYNAMIC_CACHE_CONTROL = 'private, max-age=300';
export const AVATAR_GENERATED_CACHE_CONTROL = 'private, max-age=86400';
