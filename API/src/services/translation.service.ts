import crypto from 'node:crypto';

import type { PrismaClient } from '@prisma/client';

import { getEnv, type Env } from '../config/env.js';
import { getPrisma } from '../db/prisma.js';
import { AppError } from '../utils/errors.js';

type TranslationFile = Record<string, string>;

// Source-of-truth strings for the Auth UI. This is the file that gets translated and cached.
//
// Keep this aligned with `Auth/src/i18n/translations/en.ts`.
const EN_SOURCE: TranslationFile = {
  'auth.login.title': 'Sign in',
  'auth.register.title': 'Create your account',
  'auth.resetPassword.title': 'Reset your password',
  'auth.twoFactorVerify.title': 'Verify two-factor code',
  'auth.twoFactorSetup.title': 'Set up two-factor authentication',

  'form.email.label': 'Email',
  'form.password.label': 'Password',

  'form.login.submit': 'Sign in',
  'form.register.submit': 'Continue',
  'form.resetPassword.submit': 'Send reset instructions',

  // Used by registration and reset-password flows; must remain generic.
  'message.instructionsSent': 'We sent instructions to your email',

  'twoFactor.setup.instructions':
    'Scan this QR code with an authenticator app, then enter the 6-digit code to verify setup.',
  'twoFactor.setup.submit': 'Enable 2FA',
  'twoFactor.setup.success': 'Two-factor authentication is enabled',

  'twoFactor.verify.instructions':
    'Enter the 6-digit code from your authenticator app to finish signing in.',
  'twoFactor.verify.submit': 'Verify',
  'twoFactor.verify.success': 'Verification successful',
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (!isRecord(value)) return JSON.stringify(value);
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(',')}}`;
}

function sha256Hex(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function sourceHashFor(source: TranslationFile): string {
  return sha256Hex(stableStringify(source));
}

function safeJsonParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function extractFirstJsonObject(text: string): string {
  // Be resilient to models that wrap JSON in prose/code fences.
  const start = text.indexOf('{');
  if (start === -1) return '';
  const end = text.lastIndexOf('}');
  if (end === -1 || end <= start) return '';
  return text.slice(start, end + 1);
}

function normalizeTranslationResult(params: {
  source: TranslationFile;
  candidate: unknown;
}): TranslationFile {
  const out: TranslationFile = {};
  const obj = isRecord(params.candidate) ? params.candidate : {};

  for (const key of Object.keys(params.source)) {
    const v = obj[key];
    out[key] = typeof v === 'string' && v.trim() ? v : params.source[key];
  }

  return out;
}

async function translateWithOpenAi(params: {
  apiKey: string;
  model: string;
  targetLanguage: string;
  source: TranslationFile;
}): Promise<TranslationFile> {
  const prompt = [
    `Translate the JSON values to "${params.targetLanguage}".`,
    'Return ONLY a JSON object with the same keys.',
    'Do not add or remove keys. Do not include markdown code fences.',
    'Keep punctuation and meaning faithful. Preserve numbers and acronyms.',
    '',
    stableStringify(params.source),
  ].join('\n');

  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${params.apiKey}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: params.model,
      messages: [
        { role: 'system', content: 'You are a translation engine.' },
        { role: 'user', content: prompt },
      ],
      temperature: 0.2,
    }),
  });

  if (!res.ok) {
    throw new AppError('INTERNAL', 500, 'AI_TRANSLATION_FAILED');
  }

  const json = (await res.json().catch(() => null)) as
    | { choices?: Array<{ message?: { content?: string } }> }
    | null;
  const content = json?.choices?.[0]?.message?.content ?? '';
  const extracted = extractFirstJsonObject(content);
  const parsed = safeJsonParse(extracted || content);

  return normalizeTranslationResult({ source: params.source, candidate: parsed });
}

type TranslationPrisma = Pick<PrismaClient, 'aiTranslation'>;

export async function getAuthUiTranslations(params: {
  language: string;
}): Promise<TranslationFile> {
  // Always serve English from source; never call AI for English.
  if (params.language === 'en') return EN_SOURCE;

  const env = getEnv();
  const prisma = env.DATABASE_URL ? (getPrisma() as unknown as TranslationPrisma) : null;
  return await getAuthUiTranslationsWithDeps(
    { language: params.language },
    { env, prisma },
  );
}

export async function getAuthUiTranslationsWithDeps(
  params: { language: string },
  deps: {
    env?: Env;
    prisma?: TranslationPrisma | null;
    source?: TranslationFile;
    translate?: (p: {
      targetLanguage: string;
      source: TranslationFile;
      env: Env;
    }) => Promise<TranslationFile>;
  } = {},
): Promise<TranslationFile> {
  const env = deps.env ?? getEnv();
  const source = deps.source ?? EN_SOURCE;
  const lang = params.language.trim();
  if (!lang) throw new AppError('BAD_REQUEST', 400);
  if (lang === 'en') return source;

  const sourceHash = sourceHashFor(source);

  const prisma = deps.prisma ?? (env.DATABASE_URL ? (getPrisma() as unknown as TranslationPrisma) : null);
  if (prisma) {
    const row = await prisma.aiTranslation.findUnique({ where: { language: lang } });
    if (row && row.sourceHash === sourceHash && isRecord(row.data)) {
      return normalizeTranslationResult({ source, candidate: row.data });
    }
  }

  const translate =
    deps.translate ??
    (async ({ targetLanguage, source, env }) => {
      if (env.AI_TRANSLATION_PROVIDER !== 'openai') {
        throw new AppError('INTERNAL', 500, 'AI_TRANSLATION_DISABLED');
      }
      const apiKey = env.OPENAI_API_KEY;
      if (!apiKey) throw new AppError('INTERNAL', 500, 'OPENAI_API_KEY_MISSING');
      const model = env.OPENAI_MODEL ?? 'gpt-4o-mini';
      return await translateWithOpenAi({
        apiKey,
        model,
        targetLanguage,
        source,
      });
    });

  const translated = await translate({ targetLanguage: lang, source, env });

  if (prisma) {
    // Cache permanently after generation. We overwrite the row if the source hash changed.
    await prisma.aiTranslation.upsert({
      where: { language: lang },
      create: { language: lang, sourceHash, data: translated },
      update: { sourceHash, data: translated },
    });
  }

  return translated;
}

