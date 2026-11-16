import { billingDate, billingDateTime } from './billing-format';

/** A table date: "16 Nov 2026", with the full local date and time on hover. */
export function BillingDate({ value }: { value: string | null | undefined }) {
  if (!value) return <>—</>;
  return <time dateTime={value} title={billingDateTime(value)}>{billingDate(value)}</time>;
}
