import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/** Optional retained output from a real isolated-PG producer test. This is
 * synthetic customer data, with the test's normal mocked provider/auth tier. */
export async function exportBillingConformanceFixture(name: string, value: unknown) {
  const directory = process.env.BILLING_CONFORMANCE_EXPORT_DIR;
  if (!directory) return;
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, `${name}.json`), `${JSON.stringify(value, null, 2)}\n`);
}
