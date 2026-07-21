import { PrismaClient } from '@prisma/client';
import { afterAll, describe, expect, it } from 'vitest';

const databaseUrl = process.env.DATABASE_URL;
const describeWithDatabase = databaseUrl ? describe : describe.skip;
const prisma = databaseUrl ? new PrismaClient({ datasourceUrl: databaseUrl }) : null;

afterAll(async () => {
  await prisma?.$disconnect();
});

describeWithDatabase('credit funding action replay constraints', () => {
  it('installs exact app-key/actor/selection unique replay indexes', async () => {
    const indexes = await prisma!.$queryRaw<Array<{ indexname: string; indexdef: string }>>`
      SELECT indexname, indexdef
      FROM pg_indexes
      WHERE schemaname = 'public'
        AND indexname IN (
          'billing_credit_top_up_checkouts_actor_offer_key',
          'billing_credit_setup_checkouts_actor_option_key'
        )
      ORDER BY indexname
    `;

    expect(indexes).toEqual([
      {
        indexname: 'billing_credit_setup_checkouts_actor_option_key',
        indexdef:
          'CREATE UNIQUE INDEX billing_credit_setup_checkouts_actor_option_key ON public.billing_credit_setup_checkouts USING btree (app_key_id, actor_jti, option_id)',
      },
      {
        indexname: 'billing_credit_top_up_checkouts_actor_offer_key',
        indexdef:
          'CREATE UNIQUE INDEX billing_credit_top_up_checkouts_actor_offer_key ON public.billing_credit_top_up_checkouts USING btree (app_key_id, actor_jti, offer_id)',
      },
    ]);
  });
});
