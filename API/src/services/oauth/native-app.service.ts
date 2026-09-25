import type { NativeApp } from '@prisma/client';
import { getAdminPrisma } from '../../db/prisma.js';
import { getPublicBaseUrl } from '../../config/env.js';
import { AppError } from '../../utils/errors.js';
import { sniffAvatarUpload, toAvatarBytes } from '../avatar-subject.service.js';
import { lockProductTeamPolicyExclusive } from '../product-team-policy-lock.service.js';
import { CreateNativeAppSchema, NativeAppPolicySchema, type NativeAppPolicy } from './native-app-policy.js';
import { validatePublicScopes } from './scopes.service.js';

export function nativeAppView(app: NativeApp) {
  return { id: app.id, identifier: app.identifier, name: app.name, enabled: app.enabled,
    revision: app.revision, redirect_uris: app.redirectUris, scopes: app.scopes,
    methods: app.methods, allow_registration: app.allowRegistration,
    primary_color: app.primaryColor, background_color: app.backgroundColor, text_color: app.textColor,
    icon_url: app.iconType ? `${getPublicBaseUrl()}/oauth/apps/${encodeURIComponent(app.identifier)}/icon` : null };
}
function policyData(body: NativeAppPolicy) {
  validatePublicScopes(body.scopes.join(' '));
  return { name: body.name, enabled: body.enabled, redirectUris: [...new Set(body.redirect_uris)],
    scopes: [...new Set(body.scopes)], methods: [...new Set(body.methods)],
    allowRegistration: body.allow_registration, primaryColor: body.primary_color,
    backgroundColor: body.background_color, textColor: body.text_color };
}
export function securityPolicyChanged(app: NativeApp, next: ReturnType<typeof policyData>) {
  const sameSet = (a: string[], b: string[]) => [...a].sort().join('\0') === [...b].sort().join('\0');
  return app.enabled !== next.enabled || app.allowRegistration !== next.allowRegistration ||
    !sameSet(app.redirectUris, next.redirectUris) || !sameSet(app.scopes, next.scopes) ||
    !sameSet(app.methods, next.methods);
}
export async function listNativeApps() {
  return (await getAdminPrisma().nativeApp.findMany({ orderBy: { name: 'asc' } })).map(nativeAppView);
}
export async function saveNativeApp(input: unknown, actorEmail: string, id?: string) {
  const body = id ? NativeAppPolicySchema.parse(input) : CreateNativeAppSchema.parse(input);
  const data = policyData(body);
  return getAdminPrisma().$transaction(async (tx) => {
    await lockProductTeamPolicyExclusive(tx);
    const previous = id ? await tx.nativeApp.findUnique({ where: { id } }) : null;
    if (id && !previous) throw new AppError('NOT_FOUND', 404);
    if (!id && await tx.nativeApp.findUnique({ where: { identifier: CreateNativeAppSchema.parse(input).identifier }, select: { id: true } })) throw new AppError('BAD_REQUEST', 409, 'APP_IDENTIFIER_EXISTS');
    const app = previous
      ? await tx.nativeApp.update({ where: { id }, data: { ...data,
        revision: { increment: securityPolicyChanged(previous, data) ? 1 : 0 } } })
      : await tx.nativeApp.create({ data: { ...data, identifier: CreateNativeAppSchema.parse(input).identifier } });
    await tx.adminAuditLog.create({ data: { actorEmail, action: previous ? 'native_app.updated' : 'native_app.created',
      metadata: { app_id: app.identifier, revision: app.revision, enabled: app.enabled,
        previous: previous ? { redirect_uris: previous.redirectUris, scopes: previous.scopes, methods: previous.methods, allow_registration: previous.allowRegistration } : null,
        redirect_uris: app.redirectUris, scopes: app.scopes, methods: app.methods, allow_registration: app.allowRegistration } } });
    return nativeAppView(app);
  });
}
export async function setNativeAppIcon(id: string, data: Buffer | null, actorEmail: string) {
  if (data && data.length > 256 * 1024) throw new AppError('BAD_REQUEST', 413);
  const iconType = data ? sniffAvatarUpload(data) : null;
  return getAdminPrisma().$transaction(async (tx) => {
    if (!await tx.nativeApp.findUnique({ where: { id }, select: { id: true } })) throw new AppError('NOT_FOUND', 404);
    const app = await tx.nativeApp.update({ where: { id }, data: {
      iconData: data ? toAvatarBytes(data) : null, iconType,
    } });
    await tx.adminAuditLog.create({ data: { actorEmail, action: 'native_app.icon_updated', metadata: { app_id: app.identifier } } });
    return nativeAppView(app);
  });
}
