import type { Prisma } from '@prisma/client';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';

import { AVATAR_MAX_BYTES } from '../../config/constants.js';
import { configVerifier } from '../../middleware/config-verifier.js';
import { AVATAR_STYLES, isAvatarStyle, type AvatarStyle } from '../../utils/avatar-svg.js';
import { normalizeDomain } from '../../utils/domain.js';
import { AppError } from '../../utils/errors.js';
import { machineActor, writeAuditLog } from '../../services/audit-log.service.js';
import type { AvatarUploadResult, ResolvedAvatar } from '../../services/avatar.service.js';

/** Shared `?style=` / `?size=` parsing for every avatar GET (Docs/Auth/avatars.md §2). */
export const AvatarImageQueryFields = {
  style: z.enum(AVATAR_STYLES).optional(),
  size: z.coerce.number().int().optional(),
} as const;

/** Multipart body limit: the 1 MiB image plus room for the multipart envelope itself. */
export const AVATAR_UPLOAD_BODY_LIMIT = AVATAR_MAX_BYTES + 32 * 1024;

/**
 * SVG is an active document format. Generated avatars contain no scripts or external references,
 * but the response says so explicitly so a browser cannot be talked into treating one as one.
 */
const SVG_CSP = "default-src 'none'; style-src 'unsafe-inline'";

/**
 * Write the image response contract from Docs/Auth/avatars.md §6. `X-UOA-Avatar-Source` carries the
 * resolved source so callers get that metadata without a second JSON round trip.
 */
export function sendAvatar(
  request: FastifyRequest,
  reply: FastifyReply,
  avatar: ResolvedAvatar,
  options?: {
    /**
     * Omit `X-UOA-Avatar-Source`. Set on the public route: the header would tell an anonymous
     * caller whether a workspace uploaded a custom logo, and let them watch it change. Every
     * other avatar route has already authenticated the caller before answering.
     */
    hideSource?: boolean;
  },
): FastifyReply {
  reply
    .header('Content-Type', avatar.contentType)
    .header('Cache-Control', avatar.cacheControl)
    .header('ETag', avatar.etag)
    .header('X-Content-Type-Options', 'nosniff')
    .header('Content-Disposition', `inline; filename="${avatar.filename}"`);

  if (!options?.hideSource) {
    reply.header('X-UOA-Avatar-Source', avatar.source);
  }

  if (avatar.isSvg) {
    reply.header('Content-Security-Policy', SVG_CSP);
  }

  const ifNoneMatch = request.headers['if-none-match'];
  if (typeof ifNoneMatch === 'string' && ifNoneMatch.trim() === avatar.etag) {
    return reply.status(304).send();
  }

  return reply.status(200).send(avatar.body);
}

/** JSON envelope for PUT (spec §5). Snake_case, like the rest of the `/domain` family. */
export function avatarUploadResponse(result: AvatarUploadResult) {
  return {
    ok: true,
    avatar: {
      source: result.source,
      content_type: result.contentType,
      size_bytes: result.sizeBytes,
      updated_at: result.updatedAt.toISOString(),
    },
  };
}

/**
 * Read the single `file` part of a multipart avatar upload. Mirrors the signature-PDF upload
 * shape; the client mimetype is intentionally *not* checked here — `uploadAvatar` sniffs the magic
 * bytes and that verdict is the only one that counts.
 */
export async function readAvatarUpload(request: FastifyRequest): Promise<Buffer> {
  try {
    // Per-request limit rather than the app-wide multipart one (which is sized for signature
    // PDFs): the stream is cut off at 1 MiB instead of buffering up to 25 MiB before we check.
    const file = await request.file({ limits: { fileSize: AVATAR_MAX_BYTES } });
    if (!file || file.fieldname !== 'file') {
      throw new AppError('BAD_REQUEST', 400, 'INVALID_AVATAR_UPLOAD');
    }
    return await file.toBuffer();
  } catch (err) {
    if ((err as { code?: unknown } | null)?.code === 'FST_REQ_FILE_TOO_LARGE') {
      throw new AppError('BAD_REQUEST', 413, 'AVATAR_TOO_LARGE');
    }
    if (err instanceof AppError) throw err;
    throw new AppError('BAD_REQUEST', 400, 'INVALID_AVATAR_UPLOAD');
  }
}

/**
 * Run the full `configVerifier` only when the request actually supplied `config_url`.
 *
 * On the avatar GETs the caller's authority is the domain-hash bearer (or the admin bearer); the
 * signed config only carries an optional preference, `avatars.default_style` (Docs/Auth/avatars.md
 * §2). This never relaxes verification — a supplied config is fetched and verified exactly as on
 * any other route, and a present-but-invalid one fails the request. An absent one simply means
 * "no configured preference".
 *
 * **Register this AFTER the route's auth guard, never before.** `configVerifier` does real
 * outbound work on a caller-supplied URL — DNS resolution, an HTTPS fetch with its own multi-second
 * budget, JWKS lookup, signature verification, a handshake-error log write, and possibly
 * `tryAutoOnboard`. Running it first would let an anonymous caller aim all of that wherever it
 * liked and only then collect its 401, which is both a bandwidth amplifier and a request-slot sink
 * on the auth host. `/org/me` orders it this way for the same reason. The style preference is
 * cosmetic, so nothing downstream needs the config before the caller has been authenticated.
 *
 * Two routes still cannot be ordered this way — `auth/revoke.ts` and `domain/signatures.ts` use
 * `requireDomainHashAuth`, which derives the domain *from* the verified config — and their rate
 * limiters sit behind the config work rather than in front of it. The fix there is a pre-auth
 * limiter first, the way `auth/token-exchange.ts` does it; see the follow-up note in
 * `Docs/Auth/avatars.md` §8.
 */
export async function optionalConfigVerifier(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const configUrl = (request.query as { config_url?: unknown } | undefined)?.config_url;
  if (typeof configUrl !== 'string' || !configUrl.trim()) return;

  await configVerifier(request, reply);
}

/**
 * The four `/domain/*` avatar audit actions, spelled out rather than derived with
 * `Extract<AdminAuditAction, `domain.${string}`>` — that pattern also admits `domain.disabled`,
 * `domain.secret_rotated` and friends, so it would not actually constrain a caller.
 */
type DomainAvatarAuditAction =
  | 'domain.user_avatar_updated'
  | 'domain.user_avatar_deleted'
  | 'domain.team_avatar_updated'
  | 'domain.team_avatar_deleted';

/**
 * Record a `/domain/*` avatar mutation against the acting domain.
 *
 * `/internal/admin/*` avatar mutations have always been audited; the `/domain/*` ones were not, so
 * a product backend could replace a user's or a workspace's image leaving no trace anywhere. That
 * matters more here than on the operator side, because a `global`-scope user is ONE identity shared
 * by every domain they belong to: the row this writes is the only record of which tenant changed an
 * image that the others then render. See the header note on `registerDomainUserAvatarRoutes`.
 *
 * The actor is a client, not a person, so `actorEmail` carries a `client:` principal built from
 * `domainAuthClientDomainId` (a `ClientDomain` row cuid) — never `domainAuthClientId`, which is the
 * caller's live bearer token, not an id. See `machineActor`.
 *
 * The write is awaited and its failure propagates, matching the `/internal/admin/*` avatar routes:
 * an unrecorded change to shared state is not an acceptable success. It is not yet atomic with the
 * mutation — the billing services get that by writing their audit row inside the same
 * `$transaction`, which would mean threading a tx through `uploadAvatar`. Until then a failing
 * audit insert means a 500 on an avatar that did change.
 */
export async function recordDomainAvatarAudit(
  request: FastifyRequest,
  params: {
    action: DomainAvatarAuditAction;
    domain: string;
    metadata: Prisma.InputJsonObject;
  },
): Promise<void> {
  const domain = normalizeDomain(params.domain);

  await writeAuditLog({
    actorEmail: machineActor({ domain, clientDomainId: request.domainAuthClientDomainId }),
    action: params.action,
    targetDomain: domain,
    metadata: params.metadata,
  });
}

/**
 * The domain's configured default generated style, when the caller supplied a `config_url` that
 * `optionalConfigVerifier` already fetched and verified. A verified config for a *different*
 * domain than the authenticated one is a confusion of two trust sources and is rejected, matching
 * `requireDomainHashAuth`'s behaviour.
 */
export function configDefaultAvatarStyle(
  request: FastifyRequest,
  domain: string,
): AvatarStyle | null {
  const config = request.config;
  if (!config) return null;

  if (normalizeDomain(config.domain) !== normalizeDomain(domain)) {
    throw new AppError('UNAUTHORIZED', 401, 'CONFIG_DOMAIN_MISMATCH');
  }

  const style = (config as { avatars?: { default_style?: unknown } }).avatars?.default_style;
  return isAvatarStyle(style) ? style : null;
}
