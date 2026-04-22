const compactCountFormatter = new Intl.NumberFormat('en-US', {
  maximumFractionDigits: 1,
  notation: 'compact',
});

export function formatCompactCount(value: number): string {
  return compactCountFormatter.format(Math.max(0, value)).toLowerCase();
}
