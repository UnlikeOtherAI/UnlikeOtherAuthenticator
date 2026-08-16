# Access-token verification — how a relying party checks the signature

## The problem this solves

A relying party receiving a UOA access token could not verify it. Products
decoded the JWT and trusted the claims, with the reasoning that trust came from
the domain-hash-authenticated backchannel that delivered the token. That is
sound transport reasoning, but it is not defence in depth: **any tampering after
the exchange is undetectable by the relying party.**

The reason was structural, not an omission. The access token is signed **HS256
with `SHARED_SECRET`** — the same value used for:

- domain hashing (`createClientId`),
- the refresh-token HMAC pepper,
- signing the `login_token` chooser capability, the 2FA challenge and enrolment
  tokens, and the social state.

HMAC verification requires the signing key. Publishing it so a relying party
could verify would hand that party the ability to **mint** a token for any user
of any domain and to forge every bridge token in the auth flow. There was no
version of "let relying parties verify the HS256 token" that was not a
catastrophe. The token had to gain a signature whose public half is safe to
publish.

## What now happens

UOA can sign the user access token **RS256** with a dedicated key pair and
publish the verification key at `GET /oauth/jwks.json`.

Everything else about the token is unchanged: the same claims, the same `iss`
(`AUTH_SERVICE_IDENTIFIER`), the same `aud` (`uoa:access-token`), the same
`sub`, the same TTL. Only the signature and a new `kid` header differ. A relying
party that decodes today keeps working untouched; one that wants to verify adds
a JWKS lookup and nothing else.

```jsonc
// protected header, RS256 mode
{ "alg": "RS256", "kid": "<current key id>", "typ": "JWT" }
```

Verifying, from a relying party:

```ts
import { createRemoteJWKSet, jwtVerify } from 'jose';

const jwks = createRemoteJWKSet(new URL('https://authentication.unlikeotherai.com/oauth/jwks.json'));

const { payload } = await jwtVerify(accessToken, jwks, {
  algorithms: ['RS256'],
  issuer: '<AUTH_SERVICE_IDENTIFIER, e.g. authentication.unlikeotherai.com>',
  audience: 'uoa:access-token',
});
```

### Verification is defence in depth, not a substitute for UOA

A relying party verifying offline gets signature, issuer, audience and expiry.
It does **not** get revocation. UOA re-reads `User.tokenVersion` on every
verification and rejects a token whose `tv` no longer matches, which is what
makes logout, password change, deactivation and credential rotation take effect
before the token expires. A relying party cannot perform that check offline and
must keep treating UOA as the authority on whether a session is still live.
Signature verification catches tampering; it does not extend the token's
trustworthiness past a revocation event.

## Configuration

Two variables, set together (startup refuses one without the other):

| Variable | Meaning |
| --- | --- |
| `USER_ACCESS_TOKEN_PRIVATE_JWK` | Current RS256 private RSA JWK (JSON) with a `kid`. Secret. |
| `USER_ACCESS_TOKEN_PUBLIC_JWKS_JSON` | Public-only JWKS holding the current key **and** any retired keys still inside an unexpired token's lifetime. |

Startup also rejects a public set that does not contain the current private
key's `kid`, matching the existing tariff-snapshot and signature-evidence key
surfaces. A dedicated pair rather than a reuse of
`MCP_OAUTH_ACCESS_TOKEN_PRIVATE_JWK`: confidential resource tokens, tariff
snapshots, Ledger assertions and user sessions are four different audiences, and
the estate already keeps each on its own trust surface.

With neither set, the token is HS256 exactly as before. This is the default.

## Both algorithms are accepted, and that is not a downgrade

`verifyAccessToken` chooses its branch from the protected header:

- `alg: RS256` → verified **only** against the published JWKS, with
  `algorithms: ['RS256']`. Refused outright if this deployment publishes no key.
- anything else → the existing HS256 path, pinned to `algorithms: ['HS256']`
  and the shared secret.

The two branches never share key material. A token claiming `HS256` can never be
verified with a public key, and a token claiming `RS256` can never be verified
with the shared secret, so the classic algorithm-confusion attack — take the
published RSA public key, use its bytes as an HMAC secret, and sign `HS256` —
fails. `alg: none` fails. An RS256 token signed by an unpublished key fails.
Each of these is a test in `API/tests/unit/user-access-token-rs256.test.ts`.

## Migration

The change is additive in both directions, so there is no coordinated cutover.

1. **Generate a key pair** and load both halves into Secret Manager
   (`uoa-auth-user-access-token-private-jwk`,
   `uoa-auth-user-access-token-public-jwks-json`).
2. **Deploy.** UOA immediately begins issuing RS256 tokens and publishing the
   key. Tokens already in flight are HS256 and keep verifying until they expire
   — UOA accepts both, so there is no window in which live sessions break.
3. **Products adopt verification at their own pace.** A product that still
   decodes without verifying is unaffected. A product that wants verification
   points `createRemoteJWKSet` at `/oauth/jwks.json`. Nothing has to happen in
   lockstep, and nothing has to happen at all for the deployment to be correct.
4. **Rollback** is unsetting the two variables and redeploying. Tokens issued as
   RS256 stop verifying at that point, so roll back within one access-token TTL
   (`ACCESS_TOKEN_TTL`, 15–60 minutes) or expect affected sessions to re-exchange
   their refresh token — which succeeds, because refresh tokens are opaque and
   unaffected.

### Key rotation

Add the new public key to `USER_ACCESS_TOKEN_PUBLIC_JWKS_JSON` **first** and
deploy, so every replica publishes it. Then switch
`USER_ACCESS_TOKEN_PRIVATE_JWK` to the new key and deploy again. Keep the retired
public key in the set for at least one `ACCESS_TOKEN_TTL` before removing it.
This is the same two-step used for tariff snapshots and Ledger assertions, and it
is why the public variable is a set rather than a single key.

## What is deliberately not covered

- **Admin tokens.** The first-party Admin panel's token is signed with
  `ADMIN_ACCESS_TOKEN_SECRET`, a separate HS256 secret, and is consumed only by
  UOA itself. It is not a relying-party token and stays HS256; the RS256 branch
  is selected only for client-domain tokens.
- **Changing `iss` or `aud`.** An absolute-URL issuer would be more idiomatic,
  but any product pinning the current host-string issuer would break. Keeping
  them identical is what makes RS256 a drop-in.
- **Refresh tokens.** They are opaque random strings stored as HMAC digests, not
  JWTs, and are only ever presented back to UOA. There is nothing for a relying
  party to verify.

## Related

- `API/src/services/user-access-token-key.service.ts` — signer, published set, RS256 verification
- `API/src/services/access-token.service.ts` — branch selection and the `tv` revocation check
- `API/src/services/token.service.ts` — issuance
- `API/src/routes/oauth/jwks.ts` — publication
- `API/tests/unit/user-access-token-rs256.test.ts` — round-trip plus the confusion negatives
- `API/tests/helpers/access-token.ts` — the algorithm-agnostic assertion the integration suite uses, so it is meaningful in both configurations
- `Docs/deploy.md` — where the variables are set
