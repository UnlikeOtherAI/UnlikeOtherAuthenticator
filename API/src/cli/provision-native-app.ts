import { readFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { getAdminAuthDomain, getEnv } from '../config/env.js';
import { getAdminPrisma, disconnectPrisma } from '../db/prisma.js';
import { CreateNativeAppSchema, NativeAppPolicySchema } from '../services/oauth/native-app-policy.js';
import { saveNativeApp, setNativeAppIcon } from '../services/oauth/native-app.service.js';
import { sniffAvatarUpload } from '../services/avatar-subject.service.js';

// Operator-only database tooling. HTTP callers must use the superuser Admin API.
async function main() {
  const { values } = parseArgs({ options: {
    input: { type: 'string' }, actor: { type: 'string' }, id: { type: 'string' },
    icon: { type: 'string' }, apply: { type: 'boolean', default: false },
  } });
  if (!values.input || !values.actor || !process.env.DATABASE_ADMIN_URL) {
    throw new Error('Require --input, --actor and DATABASE_ADMIN_URL; use --apply to write.');
  }
  const raw: unknown = JSON.parse(await readFile(values.input, 'utf8'));
  const policy = values.id ? NativeAppPolicySchema.parse(raw) : CreateNativeAppSchema.parse(raw);
  const icon = values.icon ? await readFile(values.icon) : null;
  if (icon) {
    if (icon.length > 256 * 1024) throw new Error('Icon exceeds 256 KiB');
    sniffAvatarUpload(icon);
  }
  if (!values.apply) {
    process.stdout.write(JSON.stringify({ dry_run: true, policy, icon_bytes: icon?.length ?? 0 }) + '\n');
    return;
  }
  // Check the named operator exists with current superuser authority, exactly as
  // Admin does; a database connection alone must not manufacture an audit actor.
  const operator = await getAdminPrisma().user.findFirst({ where: { email: values.actor } });
  if (!operator) throw new Error('Operator user not found');
  const role = await getAdminPrisma().domainRole.findUnique({
    where: { domain_userId: { domain: getAdminAuthDomain(getEnv()), userId: operator.id } },
  });
  if (role?.role !== 'SUPERUSER') throw new Error('Operator is not an admin superuser');
  const app = await saveNativeApp(policy, values.actor, values.id);
  if (icon) await setNativeAppIcon(app.id, icon, values.actor);
  process.stdout.write(JSON.stringify({ id: app.id, identifier: app.identifier, revision: app.revision }) + '\n');
}
main().catch(() => {
  // Database errors can include connection details: never dump them to the console.
  process.stderr.write('Native app provisioning failed; validate input and operator access.\n');
  process.exitCode = 1;
}).finally(disconnectPrisma);
