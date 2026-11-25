type LocalRentalType = 'local' | 'national';

// Twilio's Local inventory can contain both classes. Only positively identified
// prefixes can disambiguate a country that advertises both in its Pricing API.
// Sources: twilio.com/en-us/guidelines/{gb,fr,jp}/porting and
// twilio.com/en-us/guidelines/{at,cz,jp,na}/regulatory.
const localInventoryPrefixes: Readonly<Record<string, Partial<Record<LocalRentalType, RegExp>>>> = {
  AT: { national: /^\+43720/ },
  CZ: { national: /^\+420910/ },
  FR: { local: /^\+33[1-5]/, national: /^\+339/ },
  GB: { local: /^\+44[12]/, national: /^\+443/ },
  JP: { local: /^\+81[36]/, national: /^\+8150/ },
  NA: { national: /^\+26483/ },
};

/** Pass the rental classes in the account's country catalogue, including unpriced rows. */
export function localPhoneNumberRentalType(country: string, number: string, pricedTypes: readonly string[]):
  LocalRentalType | null {
  const available = (['local', 'national'] as const).filter((type) => pricedTypes.includes(type));
  const prefixes = localInventoryPrefixes[country];
  const known = (['local', 'national'] as const).find((type) => prefixes?.[type]?.test(number));
  if (known) return available.includes(known) ? known : null;
  return available.length === 1 ? available[0] ?? null : null;
}
