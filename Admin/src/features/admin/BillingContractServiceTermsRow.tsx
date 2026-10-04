import { FieldShell, SelectField, TextField } from '../../components/ui/FormFields';
import type { BillingService } from '../../schemas/billing';

export type ServiceSelection = {
  enabled: boolean;
  amount: string;
  monthlyChargeBasis: 'flat' | 'per_seat';
  seatPolicy: 'automatic' | 'fixed';
  seatChargeTiming: 'full_month' | 'prorated';
  usagePaymentMode: 'pay_as_you_go' | 'prepaid';
  fixedSeatQuantity: string;
};

export function defaultServiceSelection(): ServiceSelection {
  return {
    enabled: false, amount: '', monthlyChargeBasis: 'flat',
    seatPolicy: 'automatic', seatChargeTiming: 'prorated',
    usagePaymentMode: 'prepaid', fixedSeatQuantity: '',
  };
}

export function BillingContractServiceTermsRow({ service, value, currency, onChange }: {
  service: BillingService;
  value: ServiceSelection;
  currency: string;
  onChange: (patch: Partial<ServiceSelection>) => void;
}) {
  const label = service.name;
  return (
    <div className="space-y-3 px-4 py-4">
      <label className="flex items-center gap-2 text-sm font-medium text-gray-800">
        <input type="checkbox" checked={value.enabled}
          onChange={(event) => onChange({ enabled: event.target.checked })} />
        {label}
        <span className="text-xs font-normal text-gray-400">{service.identifier}</span>
      </label>
      <div className="grid gap-3 sm:grid-cols-2">
        <FieldShell label={`${label} monthly price${value.monthlyChargeBasis === 'per_seat'
          ? ' per seat' : ''} (${currency})`}>
          <TextField aria-label={`${label} monthly price in ${currency}`}
            disabled={!value.enabled} inputMode="numeric" value={value.amount}
            onChange={(event) => onChange({ amount: event.target.value })} />
        </FieldShell>
        {value.enabled ? (
          <>
          <FieldShell label={`${label} subscription basis`}>
            <SelectField value={value.monthlyChargeBasis}
              onChange={(event) => onChange({ monthlyChargeBasis: event.target.value as
                ServiceSelection['monthlyChargeBasis'] })}>
              <option value="flat">Flat monthly fee</option>
              <option value="per_seat">Price per seat</option>
            </SelectField>
          </FieldShell>
          <FieldShell label={`${label} usage payment`}>
            <SelectField value={value.usagePaymentMode}
              onChange={(event) => onChange({ usagePaymentMode: event.target.value as
                ServiceSelection['usagePaymentMode'] })}>
              <option value="prepaid">Prepaid token pool</option>
              <option value="pay_as_you_go">Pay as you go</option>
            </SelectField>
          </FieldShell>
          {value.monthlyChargeBasis === 'per_seat' ? (
            <>
              <FieldShell label={`${label} seat quantity policy`}>
                <SelectField value={value.seatPolicy}
                  onChange={(event) => onChange({ seatPolicy: event.target.value as
                    ServiceSelection['seatPolicy'] })}>
                  <option value="automatic">Automatic active humans</option>
                  <option value="fixed">Fixed purchased capacity</option>
                </SelectField>
              </FieldShell>
              <FieldShell label={`${label} seat charge timing`}>
                <SelectField value={value.seatChargeTiming}
                  onChange={(event) => onChange({ seatChargeTiming: event.target.value as
                    ServiceSelection['seatChargeTiming'] })}>
                  <option value="prorated">Prorated membership periods</option>
                  <option value="full_month">Full month</option>
                </SelectField>
              </FieldShell>
              {value.seatPolicy === 'fixed' ? (
                <FieldShell label={`${label} purchased seats`}>
                  <TextField inputMode="numeric" value={value.fixedSeatQuantity}
                    onChange={(event) => onChange({ fixedSeatQuantity: event.target.value })} />
                </FieldShell>
              ) : null}
            </>
          ) : null}
          </>
        ) : null}
      </div>
    </div>
  );
}
