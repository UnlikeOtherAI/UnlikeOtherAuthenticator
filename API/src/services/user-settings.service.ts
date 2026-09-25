import type { Prisma, PrismaClient } from '@prisma/client';

import {
  USER_SETTINGS_MAX_DEPTH,
  USER_SETTINGS_MAX_ENTRIES,
  USER_SETTINGS_MAX_PATCH_ENTRIES,
  USER_SETTINGS_MAX_TOTAL_BYTES,
  USER_SETTINGS_MAX_VALUE_BYTES,
} from '../config/constants.js';
import { getEnv } from '../config/env.js';
import { getAdminPrisma } from '../db/prisma.js';
import { AppError } from '../utils/errors.js';

/**
 * Namespace and key formats (Docs/Auth/user-settings.md §2). Both must start with an
 * alphanumeric, which also rules out `__proto__` and friends as object keys in responses. The
 * migration's CHECK constraints repeat these exactly.
 */
export const USER_SETTINGS_NAMESPACE_PATTERN = /^[a-z0-9][a-z0-9_.-]{0,63}$/;
export const USER_SETTINGS_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;

// A UTF-16 surrogate half with no partner. JSON.stringify escapes it, but Postgres `jsonb` rejects
// the escape, so it has to be refused here rather than surfacing as a 500.
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

export type SettingsMap = Record<string, Prisma.JsonValue>;

export type NamespaceSettings = {
  namespace: string;
  settings: SettingsMap;
  updatedAt: Date | null;
};

export type SettingEntry = {
  namespace: string;
  key: string;
  value: Prisma.JsonValue;
  updatedAt: Date;
};

export type UserSettingsOverview = {
  namespaces: Record<string, SettingsMap>;
  usage: { entries: number; sizeBytes: number };
};

type SettingsPrisma = Pick<PrismaClient, 'userSetting' | '$transaction'>;

export type UserSettingsDeps = { prisma?: SettingsPrisma };

function prismaFor(deps?: UserSettingsDeps): SettingsPrisma {
  if (deps?.prisma) return deps.prisma;
  if (!getEnv().DATABASE_URL) throw new AppError('NOT_FOUND', 404, 'USER_SETTINGS_DB_DISABLED');
  return getAdminPrisma();
}

function invalid(): AppError {
  return new AppError('BAD_REQUEST', 400, 'INVALID_USER_SETTINGS');
}

function assertNamespace(namespace: string): void {
  if (!USER_SETTINGS_NAMESPACE_PATTERN.test(namespace)) throw invalid();
}

function assertKey(key: string): void {
  if (!USER_SETTINGS_KEY_PATTERN.test(key)) throw invalid();
}

function isStorableString(value: string): boolean {
  return !value.includes('\u0000') && !LONE_SURROGATE.test(value);
}

/**
 * Check a value can be stored as-is and return its serialized UTF-8 size.
 *
 * Any JSON value except a top-level `null` is accepted (`null` is the PATCH delete marker).
 * Refused: nesting deeper than USER_SETTINGS_MAX_DEPTH, non-finite numbers (JSON cannot carry
 * them), and strings or object keys containing NUL or a lone surrogate (Postgres `jsonb` cannot
 * store them). The walk is iterative so a hostile nesting depth cannot exhaust the stack.
 */
export function measureSettingValue(value: unknown): number {
  if (value === null || value === undefined) throw invalid();

  const stack: Array<{ node: unknown; depth: number }> = [{ node: value, depth: 1 }];
  for (let entry = stack.pop(); entry; entry = stack.pop()) {
    const { node, depth } = entry;
    if (depth > USER_SETTINGS_MAX_DEPTH) throw invalid();

    if (node === null || typeof node === 'boolean') continue;
    if (typeof node === 'string') {
      if (!isStorableString(node)) throw invalid();
      continue;
    }
    if (typeof node === 'number') {
      if (!Number.isFinite(node)) throw invalid();
      continue;
    }
    if (Array.isArray(node)) {
      for (const item of node) stack.push({ node: item, depth: depth + 1 });
      continue;
    }
    if (typeof node === 'object') {
      for (const [key, item] of Object.entries(node)) {
        if (!isStorableString(key)) throw invalid();
        stack.push({ node: item, depth: depth + 1 });
      }
      continue;
    }
    throw invalid();
  }

  const sizeBytes = Buffer.byteLength(JSON.stringify(value), 'utf8');
  if (sizeBytes > USER_SETTINGS_MAX_VALUE_BYTES) {
    throw new AppError('BAD_REQUEST', 413, 'SETTING_VALUE_TOO_LARGE');
  }
  return sizeBytes;
}

function toNamespaceSettings(
  namespace: string,
  rows: Array<{ key: string; value: Prisma.JsonValue; updatedAt: Date }>,
): NamespaceSettings {
  const settings: SettingsMap = {};
  let updatedAt: Date | null = null;
  for (const row of rows) {
    settings[row.key] = row.value;
    if (!updatedAt || row.updatedAt > updatedAt) updatedAt = row.updatedAt;
  }
  return { namespace, settings, updatedAt };
}

const ROW_SELECT = { key: true, value: true, updatedAt: true } as const;

/** Every namespace the user has, plus their current usage against the quota. */
export async function listUserSettings(
  params: { userId: string },
  deps?: UserSettingsDeps,
): Promise<UserSettingsOverview> {
  const rows = await prismaFor(deps).userSetting.findMany({
    where: { userId: params.userId },
    select: { namespace: true, key: true, value: true, sizeBytes: true },
    orderBy: [{ namespace: 'asc' }, { key: 'asc' }],
  });

  const namespaces: Record<string, SettingsMap> = {};
  let sizeBytes = 0;
  for (const row of rows) {
    (namespaces[row.namespace] ??= {})[row.key] = row.value;
    sizeBytes += row.sizeBytes;
  }

  return { namespaces, usage: { entries: rows.length, sizeBytes } };
}

/** One namespace. An unknown namespace is simply empty — namespaces exist only through keys. */
export async function getUserSettingsNamespace(
  params: { userId: string; namespace: string },
  deps?: UserSettingsDeps,
): Promise<NamespaceSettings> {
  assertNamespace(params.namespace);

  const rows = await prismaFor(deps).userSetting.findMany({
    where: { userId: params.userId, namespace: params.namespace },
    select: ROW_SELECT,
    orderBy: { key: 'asc' },
  });

  return toNamespaceSettings(params.namespace, rows);
}

/** One key. A missing key is the standard generic 404. */
export async function getUserSetting(
  params: { userId: string; namespace: string; key: string },
  deps?: UserSettingsDeps,
): Promise<SettingEntry> {
  assertNamespace(params.namespace);
  assertKey(params.key);

  const row = await prismaFor(deps).userSetting.findUnique({
    where: {
      userId_namespace_key: {
        userId: params.userId,
        namespace: params.namespace,
        key: params.key,
      },
    },
    select: ROW_SELECT,
  });
  if (!row) throw new AppError('NOT_FOUND', 404, 'USER_SETTING_NOT_FOUND');

  return { namespace: params.namespace, key: row.key, value: row.value, updatedAt: row.updatedAt };
}

/**
 * Upsert and delete keys inside one namespace, atomically (Docs/Auth/user-settings.md §4).
 * A `null` value deletes that key; every other value replaces the stored one whole — there is no
 * deep merge, so a list such as `bookmarks` is always written as the complete new list.
 *
 * The user row is locked for the duration so concurrent writers for the same user serialize and
 * the quota check after the writes sees every committed row. Exceeding the quota rolls the whole
 * change back. Returns the namespace as it stands after the write.
 */
export async function updateUserSettings(
  params: { userId: string; namespace: string; entries: Record<string, unknown> },
  deps?: UserSettingsDeps,
): Promise<NamespaceSettings> {
  const { userId, namespace } = params;
  assertNamespace(namespace);

  const keys = Object.keys(params.entries);
  if (keys.length === 0 || keys.length > USER_SETTINGS_MAX_PATCH_ENTRIES) throw invalid();

  const deletions: string[] = [];
  const upserts: Array<{ key: string; value: Prisma.InputJsonValue; sizeBytes: number }> = [];
  for (const key of keys) {
    assertKey(key);
    const value = params.entries[key];
    if (value === null) {
      deletions.push(key);
    } else {
      const sizeBytes = measureSettingValue(value);
      upserts.push({ key, value: value as Prisma.InputJsonValue, sizeBytes });
    }
  }

  return await prismaFor(deps).$transaction(async (tx) => {
    // NO KEY UPDATE rather than UPDATE: it still serializes settings writers for this user, but
    // does not block the FK KEY SHARE locks unrelated child-table inserts take on the user row.
    const locked = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT id FROM users WHERE id = ${userId} FOR NO KEY UPDATE
    `;
    if (locked.length === 0) throw new AppError('NOT_FOUND', 404, 'USER_NOT_FOUND');

    if (deletions.length > 0) {
      await tx.userSetting.deleteMany({ where: { userId, namespace, key: { in: deletions } } });
    }
    for (const { key, value, sizeBytes } of upserts) {
      await tx.userSetting.upsert({
        where: { userId_namespace_key: { userId, namespace, key } },
        create: { userId, namespace, key, value, sizeBytes },
        update: { value, sizeBytes },
        select: { key: true },
      });
    }

    if (upserts.length > 0) {
      const usage = await tx.userSetting.aggregate({
        where: { userId },
        _count: { _all: true },
        _sum: { sizeBytes: true },
      });
      if (
        usage._count._all > USER_SETTINGS_MAX_ENTRIES ||
        (usage._sum.sizeBytes ?? 0) > USER_SETTINGS_MAX_TOTAL_BYTES
      ) {
        throw new AppError('BAD_REQUEST', 413, 'SETTINGS_QUOTA_EXCEEDED');
      }
    }

    const rows = await tx.userSetting.findMany({
      where: { userId, namespace },
      select: ROW_SELECT,
      orderBy: { key: 'asc' },
    });
    return toNamespaceSettings(namespace, rows);
  });
}

/** Remove one key. Idempotent. */
export async function deleteUserSetting(
  params: { userId: string; namespace: string; key: string },
  deps?: UserSettingsDeps,
): Promise<void> {
  assertNamespace(params.namespace);
  assertKey(params.key);

  await prismaFor(deps).userSetting.deleteMany({
    where: { userId: params.userId, namespace: params.namespace, key: params.key },
  });
}

/** Remove a whole namespace. Idempotent; returns how many keys were removed. */
export async function deleteUserSettingsNamespace(
  params: { userId: string; namespace: string },
  deps?: UserSettingsDeps,
): Promise<number> {
  assertNamespace(params.namespace);

  const result = await prismaFor(deps).userSetting.deleteMany({
    where: { userId: params.userId, namespace: params.namespace },
  });
  return result.count;
}
