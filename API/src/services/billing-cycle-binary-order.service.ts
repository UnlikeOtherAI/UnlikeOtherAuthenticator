/** Financial snapshot order is independent of the host's locale and collation. */
export function compareBillingCycleUtf8(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'));
}
