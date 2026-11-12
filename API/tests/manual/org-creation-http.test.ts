import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as wait } from 'node:timers/promises';
import { describe, it } from 'vitest';
import { createApp } from '../../src/app.js';
import { ATTACKER_DOMAIN, useBackendRlsFixture } from '../helpers/backend-rls-fixture.js';
import { createTestUser } from '../helpers/org-user-endpoints-helper.js';
import { seedDomainSecret } from '../helpers/domain-secret.js';

// Opt-in loopback server for using the public HTTP interface from a separate
// client. Only the synthetic product's signed-config/JWKS hosts are fixture
// transports; the API, authentication, RLS, transactions and responses are real.
describe.skipIf(!process.env.UOA_CREATION_HTTP_FIXTURE_DIR)('manual creation HTTP fixture', () => {
  const { state, stubConfigs } = useBackendRlsFixture();
  it('serves until the operator stops it', async () => {
    const directory = path.resolve(process.env.UOA_CREATION_HTTP_FIXTURE_DIR!);
    const port = Number(process.env.UOA_CREATION_HTTP_PORT ?? 57262);
    if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Invalid fixture port');
    await mkdir(directory, { recursive: true });
    await stubConfigs({ allowUserCreateOrg: true });
    const owner = await createTestUser(state.handle!, `${randomUUID()}@example.com`);
    await state.handle!.prisma.domainRole.create({ data: { domain: ATTACKER_DOMAIN, userId: owner.id } });
    const bearer = await seedDomainSecret(state.handle!.prisma, ATTACKER_DOMAIN);
    let app = await createApp();
    const start = async () => { await app.listen({ host: '127.0.0.1', port }); };
    const report = async () => {
      const organisations = await state.handle!.prisma.organisation.findMany({
        where: { ownerId: owner.id }, select: { id: true },
      });
      const orgIds = organisations.map(row => row.id);
      await writeFile(path.join(directory, 'counts.json'), JSON.stringify({
        organisations: organisations.length,
        teams: await state.handle!.prisma.team.count({ where: { orgId: { in: orgIds } } }),
        audits: await state.handle!.prisma.orgAuditLog.count({ where: { orgId: { in: orgIds } } }),
        receipts: await state.handle!.prisma.orgCreationOperation.count({ where: { resultOrgId: { in: orgIds } } }),
      }));
    };
    try {
      await start();
      await writeFile(path.join(directory, 'client.json'), JSON.stringify({
        baseUrl: `http://127.0.0.1:${port}`, domain: ATTACKER_DOMAIN,
        configUrl: `https://${ATTACKER_DOMAIN}/auth-config`, bearer, ownerId: owner.id, key: randomUUID(),
      }), { mode: 0o600 });
      await writeFile(path.join(directory, 'ready.json'), JSON.stringify({ port, generation: 0 }));
      let previous = '';
      for (;;) {
        const command = await readFile(path.join(directory, 'command.json'), 'utf8').catch(() => '');
        if (command && command !== previous) {
          previous = command;
          const action = JSON.parse(command) as { action: string; generation: number };
          if (action.action === 'stop') break;
          if (action.action === 'restart') {
            await app.close();
            app = await createApp();
            await start();
          }
          await report();
          await writeFile(path.join(directory, 'ready.json'), JSON.stringify({ port, generation: action.generation }));
        }
        await wait(250);
      }
      await report();
    } finally { await app.close(); }
  }, 15 * 60_000);
});
