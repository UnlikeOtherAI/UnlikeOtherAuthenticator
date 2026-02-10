import { describe, expect, it, vi } from 'vitest';

import type { Env } from '../../src/config/env.js';
import { getAuthUiTranslationsWithDeps } from '../../src/services/translation.service.js';

type TranslationRow = { language: string; sourceHash: string; data: unknown };

type PrismaStub = {
  aiTranslation: {
    findUnique: (args: { where: { language: string } }) => Promise<TranslationRow | null>;
    upsert: (args: {
      where: { language: string };
      create: { language: string; sourceHash: string; data: unknown };
      update: { sourceHash: string; data: unknown };
    }) => Promise<TranslationRow>;
  };
};

function testEnv(overrides?: Partial<Env>): Env {
  return {
    NODE_ENV: 'test',
    HOST: '127.0.0.1',
    PORT: 3000,
    PUBLIC_BASE_URL: 'https://auth.example.com',
    LOG_LEVEL: 'info',
    SHARED_SECRET: 'test-shared-secret',
    AUTH_SERVICE_IDENTIFIER: 'uoa-auth-service',
    DATABASE_URL: 'postgres://example.invalid/db',
    ACCESS_TOKEN_TTL: '30m',
    LOG_RETENTION_DAYS: 90,
    AI_TRANSLATION_PROVIDER: 'disabled',
    OPENAI_API_KEY: undefined,
    OPENAI_MODEL: undefined,
    ...overrides,
  };
}

describe('getAuthUiTranslationsWithDeps', () => {
  it('caches translations by language + source hash', async () => {
    const store = new Map<string, TranslationRow>();

    const prisma: PrismaStub = {
      aiTranslation: {
        findUnique: async ({ where }) => store.get(where.language) ?? null,
        upsert: async ({ where, create, update }) => {
          const existing = store.get(where.language);
          const next = existing
            ? { ...existing, ...update, language: where.language }
            : { ...create };
          store.set(where.language, next);
          return next;
        },
      },
    };

    const translate = vi.fn(async () => ({ hello: 'bonjour', bye: 'au revoir' }));

    const source = { hello: 'hello', bye: 'bye' };

    const r1 = await getAuthUiTranslationsWithDeps(
      { language: 'fr' },
      { env: testEnv(), prisma, source, translate: async (p) => await translate(p) },
    );
    const r2 = await getAuthUiTranslationsWithDeps(
      { language: 'fr' },
      { env: testEnv(), prisma, source, translate: async (p) => await translate(p) },
    );

    expect(r1).toEqual({ hello: 'bonjour', bye: 'au revoir' });
    expect(r2).toEqual({ hello: 'bonjour', bye: 'au revoir' });
    expect(translate).toHaveBeenCalledTimes(1);
  });

  it('re-generates when the source file changes', async () => {
    const store = new Map<string, TranslationRow>();

    const prisma: PrismaStub = {
      aiTranslation: {
        findUnique: async ({ where }) => store.get(where.language) ?? null,
        upsert: async ({ where, create, update }) => {
          const existing = store.get(where.language);
          const next = existing
            ? { ...existing, ...update, language: where.language }
            : { ...create };
          store.set(where.language, next);
          return next;
        },
      },
    };

    const translate = vi
      .fn()
      .mockResolvedValueOnce({ a: 'x' })
      .mockResolvedValueOnce({ a: 'y', b: 'z' });

    const env = testEnv();

    await getAuthUiTranslationsWithDeps(
      { language: 'de' },
      { env, prisma, source: { a: 'A' }, translate: async (p) => await translate(p) },
    );
    const r2 = await getAuthUiTranslationsWithDeps(
      { language: 'de' },
      { env, prisma, source: { a: 'A', b: 'B' }, translate: async (p) => await translate(p) },
    );

    expect(r2).toEqual({ a: 'y', b: 'z' });
    expect(translate).toHaveBeenCalledTimes(2);
  });
});

