import { z } from 'zod';
import type { PrismaClient } from '@prisma/client';
import { getEnv } from '../config/env.js';
import { AppError } from '../utils/errors.js';
import type { ClientConfig } from './config.service.js';
import { parseDirectoryWebhookTargets, signDirectoryWebhook } from './directory-webhook.service.js';

const EntryTeamInterfaceSchema = z.enum(['family', 'work']);
export type EntryTeamInterface = z.infer<typeof EntryTeamInterfaceSchema>;

const ReferenceSchema = z.object({
  orgId: z.string().min(1).max(256),
  teamId: z.string().min(1).max(256),
}).strict();
type Reference = z.infer<typeof ReferenceSchema>;
const BATCH_SIZE = 40;
const ResponseSchema = z.object({
  teams: z.array(ReferenceSchema.extend({ interface: EntryTeamInterfaceSchema })).max(BATCH_SIZE),
}).strict();

const key = (reference: Reference): string => JSON.stringify([reference.orgId, reference.teamId]);

/** Query the registered product about its own display classification using references alone. */
export async function matchingEntryTeams(
  config: ClientConfig,
  references: readonly Reference[],
  prisma: Pick<PrismaClient, 'team'>,
  deps?: { fetch?: typeof fetch; targetsJson?: string },
): Promise<(reference: Reference) => boolean> {
  const entryInterface = config.login_flow?.team_interface;
  if (!entryInterface) return () => true;
  const target = parseDirectoryWebhookTargets(deps?.targetsJson ?? getEnv().DIRECTORY_WEBHOOK_TARGETS_JSON)
    .find((candidate) => candidate.domain === config.domain);
  if (!target) throw new AppError('SERVICE_UNAVAILABLE', 503, 'TEAM_CHOICES_UNAVAILABLE');
  const endpoint = new URL(target.url);
  if (!endpoint.pathname.endsWith('/directory-webhook')) {
    throw new AppError('SERVICE_UNAVAILABLE', 503, 'TEAM_CHOICES_UNAVAILABLE');
  }
  endpoint.pathname = endpoint.pathname.replace(/\/directory-webhook$/, '/team-interfaces');
  endpoint.search = '';

  const pairs = references.map(({ orgId, teamId }) => ({ orgId, teamId }));
  const unique = [...new Map(pairs.map((pair) => [key(pair), pair])).values()];
  const ids = unique.map((reference) => reference.teamId);
  const created = ids.length ? await prisma.team.findMany({
    where: { id: { in: ids }, entryInterface: { not: null }, org: { domain: config.domain } },
    select: { id: true, orgId: true, entryInterface: true },
  }) : [];
  const createdByKey = new Map(created.map((team) => [key({ orgId: team.orgId, teamId: team.id }), team.entryInterface]));
  const matches = new Set(unique.filter((reference) => createdByKey.get(key(reference)) === entryInterface).map(key));
  const unclassified = unique.filter((reference) => !createdByKey.has(key(reference)));

  try {
    const signal = AbortSignal.timeout(2_000);
    for (let offset = 0; offset < unclassified.length; offset += BATCH_SIZE) {
      const batch = unclassified.slice(offset, offset + BATCH_SIZE);
      const body = JSON.stringify({ type: 'team.interfaces', version: 1, domain: config.domain, teams: batch });
      const timestamp = String(Math.floor(Date.now() / 1000));
      const response = await (deps?.fetch ?? fetch)(endpoint, {
        method: 'POST', body, redirect: 'error', signal,
        headers: {
          'content-type': 'application/json',
          'x-uoa-timestamp': timestamp,
          'x-uoa-signature': signDirectoryWebhook(body, timestamp, target.secret),
        },
      });
      if (!response.ok) {
        await response.body?.cancel();
        throw new Error('product classification unavailable');
      }
      const { teams } = ResponseSchema.parse(await response.json());
      const byKey = new Map(teams.map((team) => [key(team), team.interface]));
      if (teams.length !== batch.length || byKey.size !== batch.length || batch.some((team) => !byKey.has(key(team)))) {
        throw new Error('incomplete product classification');
      }
      for (const team of batch) {
        if (byKey.get(key(team)) === entryInterface) matches.add(key(team));
      }
    }
  } catch {
    throw new AppError('SERVICE_UNAVAILABLE', 503, 'TEAM_CHOICES_UNAVAILABLE');
  }
  return (reference) => matches.has(key(reference));
}

export async function assertEntryTeam(
  config: ClientConfig,
  team: { orgId?: string | null; teamId?: string | null } | null,
  prisma: Pick<PrismaClient, 'team'>,
  errorCode = 'AUTHENTICATION_FAILED',
  status = 401,
): Promise<void> {
  if (!config.login_flow?.team_interface) return;
  if (team?.orgId && team.teamId) {
    const reference = { orgId: team.orgId, teamId: team.teamId };
    if ((await matchingEntryTeams(config, [reference], prisma))(reference)) return;
  }
  throw new AppError(status === 403 ? 'FORBIDDEN' : 'UNAUTHORIZED', status, errorCode);
}
