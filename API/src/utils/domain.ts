export function normalizeDomain(value: string): string {
  return value.trim().toLowerCase().replace(/\.$/, '');
}
