import type { PrismaClient } from '@prisma/client';

import { getEnv } from '../config/env.js';
import { getAdminPrisma } from '../db/prisma.js';
import { getAppLogger } from '../utils/app-logger.js';
import { AppError } from '../utils/errors.js';

/**
 * Sign-up and sign-in funnel metrics (Docs/Auth/signup-funnel-metrics.md).
 *
 * Every event adds one to a daily counter keyed by (UTC day, client domain, step, outcome).
 * Nothing that identifies a person is ever recorded: no email, IP, user id, token or flow id.
 *
 * Recording is best-effort. Callers record after the step's own work has finished — never inside
 * an authentication transaction — on the BYPASSRLS admin client, and a failed write is logged and
 * swallowed so a metric can never change an authentication outcome or its response.
 */
export const AUTH_FUNNEL_STEPS = [
  'flow_started',
  'register_submitted',
  'email_start_submitted',
  'login_submitted',
  'registration_email',
  'email_link_opened',
  'set_password',
  'social_started',
  'sign_in_completed',
  'code_exchange',
] as const;

export type AuthFunnelStep = (typeof AUTH_FUNNEL_STEPS)[number];

// Outcomes are server-chosen identifiers (a fixed outcome, a provider key, an auth method, or a
// code-rejection reason). Anything else is folded into `other` so free text can never land here.
const OUTCOME_PATTERN = /^[a-z0-9_]{1,64}$/;
const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MS = 24 * 60 * 60 * 1000;
// The longest a step waits for its counter write. A busy admin pool must not hold up sign-in;
// the write still completes in the background.
const AUTH_FUNNEL_MAX_WAIT_MS = 1_000;
export const AUTH_FUNNEL_DEFAULT_RANGE_DAYS = 30;
export const AUTH_FUNNEL_MAX_RANGE_DAYS = 366;

export type AuthFunnelWritePrisma = {
  authFunnelDailyCount?: Pick<PrismaClient['authFunnelDailyCount'], 'upsert'>;
};

type AuthFunnelReadPrisma = {
  authFunnelDailyCount: Pick<PrismaClient['authFunnelDailyCount'], 'findMany'>;
};

type AuthFunnelDeps = {
  env?: ReturnType<typeof getEnv>;
  now?: () => Date;
};

type AuthFunnelWriteDeps = AuthFunnelDeps & { prisma?: AuthFunnelWritePrisma; maxWaitMs?: number };

export type AuthFunnelCount = { step: string; outcome: string; count: number };

export type AuthFunnelSummary = {
  from: string;
  to: string;
  domain: string | null;
  domains: string[];
  totals: AuthFunnelCount[];
  days: Array<AuthFunnelCount & { day: string }>;
};

function startOfUtcDay(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

function formatDay(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function parseDay(value: string): Date {
  const parsed = DAY_PATTERN.test(value) ? new Date(`${value}T00:00:00.000Z`) : new Date(NaN);
  if (Number.isNaN(parsed.getTime()) || formatDay(parsed) !== value) {
    throw new AppError('BAD_REQUEST', 400, 'INVALID_DATE_RANGE');
  }
  return parsed;
}

function isUniqueViolation(err: unknown): boolean {
  return (err as { code?: unknown } | null)?.code === 'P2002';
}

export function normalizeAuthFunnelOutcome(outcome: string): string {
  return OUTCOME_PATTERN.test(outcome) ? outcome : 'other';
}

async function writeAuthFunnelStep(
  params: { domain: string; step: AuthFunnelStep; outcome: string },
  deps?: AuthFunnelWriteDeps,
): Promise<void> {
  const env = deps?.env ?? getEnv();
  if (!env.DATABASE_URL) return;

  const counts = deps?.prisma
    ? deps.prisma.authFunnelDailyCount
    : getAdminPrisma().authFunnelDailyCount;
  // A caller-supplied client without the model (a narrow test double) records nothing.
  if (!counts) return;

  const key = {
    day: startOfUtcDay(deps?.now ? deps.now() : new Date()),
    domain: params.domain,
    step: params.step,
    outcome: normalizeAuthFunnelOutcome(params.outcome),
  };
  const write = () =>
    counts.upsert({
      where: { day_domain_step_outcome: key },
      create: { ...key, count: 1 },
      update: { count: { increment: 1 } },
    });

  try {
    await write();
  } catch (err) {
    // Two first events of the day can race to create the row; the loser increments it instead.
    if (!isUniqueViolation(err)) throw err;
    await write();
  }
}

export async function recordAuthFunnelStep(
  params: { domain: string; step: AuthFunnelStep; outcome: string },
  deps?: AuthFunnelWriteDeps,
): Promise<void> {
  const written = writeAuthFunnelStep(params, deps).catch((err: unknown) => {
    try {
      getAppLogger().warn({ err, step: params.step }, 'auth funnel metric write failed');
    } catch {
      // Logger not initialised (unit tests): metrics stay best-effort either way.
    }
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const waited = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, deps?.maxWaitMs ?? AUTH_FUNNEL_MAX_WAIT_MS);
    timer.unref?.();
  });
  await Promise.race([written, waited]);
  clearTimeout(timer);
}

export function resolveAuthFunnelRange(
  params: { from?: string; to?: string },
  deps?: AuthFunnelDeps,
): { from: Date; to: Date } {
  const today = startOfUtcDay(deps?.now ? deps.now() : new Date());
  const to = params.to ? parseDay(params.to) : today;
  const from = params.from
    ? parseDay(params.from)
    : new Date(to.getTime() - (AUTH_FUNNEL_DEFAULT_RANGE_DAYS - 1) * DAY_MS);

  const spanDays = Math.round((to.getTime() - from.getTime()) / DAY_MS) + 1;
  if (spanDays < 1 || spanDays > AUTH_FUNNEL_MAX_RANGE_DAYS) {
    throw new AppError('BAD_REQUEST', 400, 'INVALID_DATE_RANGE');
  }
  return { from, to };
}

function addCount(
  map: Map<string, AuthFunnelCount & { day?: string }>,
  key: string,
  row: AuthFunnelCount & { day?: string },
): void {
  const existing = map.get(key);
  if (existing) existing.count += row.count;
  else map.set(key, { ...row });
}

function stepOrder(step: string): number {
  const index = (AUTH_FUNNEL_STEPS as readonly string[]).indexOf(step);
  return index === -1 ? AUTH_FUNNEL_STEPS.length : index;
}

function compareCounts(a: AuthFunnelCount, b: AuthFunnelCount): number {
  return (
    stepOrder(a.step) - stepOrder(b.step) || b.count - a.count || a.outcome.localeCompare(b.outcome)
  );
}

/**
 * Funnel summary for a UTC day range (inclusive), optionally narrowed to one client domain.
 * `domains` always lists every domain with data in the range so the caller can offer a picker.
 */
export async function getAuthFunnelSummary(
  params: { from?: string; to?: string; domain?: string },
  deps?: AuthFunnelDeps & { prisma?: AuthFunnelReadPrisma },
): Promise<AuthFunnelSummary> {
  const { from, to } = resolveAuthFunnelRange(params, deps);
  const domain = params.domain ?? null;
  const env = deps?.env ?? getEnv();
  const empty: AuthFunnelSummary = {
    from: formatDay(from),
    to: formatDay(to),
    domain,
    domains: [],
    totals: [],
    days: [],
  };
  if (!env.DATABASE_URL) return empty;

  const prisma = deps?.prisma ?? (getAdminPrisma() as unknown as AuthFunnelReadPrisma);
  const rows = await prisma.authFunnelDailyCount.findMany({
    where: { day: { gte: from, lte: to } },
    select: { day: true, domain: true, step: true, outcome: true, count: true },
  });

  const domains = new Set<string>();
  const totals = new Map<string, AuthFunnelCount>();
  const days = new Map<string, AuthFunnelCount & { day?: string }>();
  for (const row of rows) {
    domains.add(row.domain);
    if (domain && row.domain !== domain) continue;
    const day = formatDay(row.day);
    const count = { step: row.step, outcome: row.outcome, count: row.count };
    addCount(totals, `${row.step}\u0000${row.outcome}`, count);
    addCount(days, `${day}\u0000${row.step}\u0000${row.outcome}`, { ...count, day });
  }

  return {
    ...empty,
    domains: [...domains].sort(),
    totals: [...totals.values()].sort(compareCounts),
    days: [...days.values()]
      .map((row) => ({
        day: row.day ?? '',
        step: row.step,
        outcome: row.outcome,
        count: row.count,
      }))
      .sort((a, b) => a.day.localeCompare(b.day) || compareCounts(a, b)),
  };
}
