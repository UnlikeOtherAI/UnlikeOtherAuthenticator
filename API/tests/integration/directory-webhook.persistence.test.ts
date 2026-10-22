import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createTestDb } from '../helpers/test-db.js';

const enabled = Boolean(process.env.DATABASE_URL);
describe.skipIf(!enabled)('transactional directory change production', () => {
  let db: Awaited<ReturnType<typeof createTestDb>>;
  beforeAll(async () => { db = await createTestDb(); });
  afterAll(async () => { await db?.cleanup(); });

  it('commits membership/profile reference events atomically and rolls failed changes back', async () => {
    if (!db) throw new Error('Database is required');
    const prisma = db.prisma;
    const suffix = randomUUID();
    const user = await prisma.user.create({ data: { email: `${suffix}@example.test`, userKey: `${suffix}@example.test`, name: 'Before' } });
    const org = await prisma.organisation.create({ data: { domain: `${suffix}.example.test`, name: 'Organization', slug: suffix, ownerId: user.id } });
    const team = await prisma.team.create({ data: { orgId: org.id, name: 'Team', slug: 'team' } });
    await prisma.orgMember.create({ data: { orgId: org.id, userId: user.id, role: 'owner' } });
    await prisma.teamMember.create({ data: { teamId: team.id, userId: user.id } });
    const events = () => prisma.directoryWebhookEvent.findMany({ where: { orgId: org.id, teamId: team.id, subject: user.id } });
    expect(await events()).toHaveLength(1);
    await expect(prisma.$transaction(async (tx) => {
      await tx.user.update({ where: { id: user.id }, data: { name: 'Rolled back' } });
      throw new Error('rollback');
    })).rejects.toThrow('rollback');
    expect(await events()).toHaveLength(1);
    await prisma.user.update({ where: { id: user.id }, data: { name: 'After' } });
    expect(await events()).toHaveLength(2);
    // Unrelated credential bookkeeping does not send another directory event.
    await prisma.user.update({ where: { id: user.id }, data: { tokenVersion: { increment: 1 } } });
    expect(await events()).toHaveLength(2);
    await prisma.userAvatar.create({ data: { userId: user.id, contentType: 'image/png',
      data: Buffer.from('private-avatar-bytes'), sizeBytes: 20 } });
    expect(await events()).toHaveLength(3);
    await prisma.userAvatar.delete({ where: { userId: user.id } });
    expect(await events()).toHaveLength(4);
    await prisma.teamMember.update({ where: { teamId_userId: { teamId: team.id, userId: user.id } }, data: { status: 'REMOVED' } });
    expect(await events()).toHaveLength(5);
    const serialized = JSON.stringify(await events());
    expect(serialized).not.toContain('Before');
    expect(serialized).not.toContain('After');
    expect(serialized).not.toContain(user.email);
    expect(serialized).not.toContain('private-avatar-bytes');
  });
});
