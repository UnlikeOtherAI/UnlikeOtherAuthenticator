export type MeteringGroup = 'service' | 'user';

export type RawMeteringLine = {
  serviceId: string;
  usageUnit: string;
  calls: string;
  inputUnits: string;
  cachedInputUnits: string;
  outputUnits: string;
  estimatedProviderCost: string | null;
  actualProviderCost: string | null;
  currency: string | null;
  costProvenance: string | null;
  billingProduct: string;
  callerProduct: string;
  originProduct: string;
  userId: string | null;
};

export type NormalizedMeteringUsage = {
  schemaVersion: 1;
  product: string;
  groupBy: MeteringGroup;
  scope: {
    organizationId: string;
    teamId: string | null;
    userId: string | null;
    month: string | null;
    startsAt: string;
    endsAt: string;
  };
  calls: string;
  lines: RawMeteringLine[];
  snapshot: {
    cursor: string;
    id: string;
    capturedAt: string;
    immutable: true;
    sha256: string;
  };
};

export type FetchMeteringUsage = (params: {
  product: string;
  organisationId: string;
  teamId: string | null;
  billingMonth: string;
  groupBy: MeteringGroup;
  cursor?: string;
}) => Promise<NormalizedMeteringUsage>;
