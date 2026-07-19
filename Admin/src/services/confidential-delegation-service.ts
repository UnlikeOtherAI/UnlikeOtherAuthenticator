import {
  ConfidentialDelegationMappingListSchema,
  ConfidentialDelegationMappingSchema,
  type ConfidentialDelegationFormValues,
  type ConfidentialDelegationMapping,
  type ConfidentialDelegationScope,
} from '../schemas/confidential-delegation';
import { createApiClient } from './api-client';

const api = createApiClient();
const endpoint = '/internal/admin/confidential-delegations';

export type ConfidentialDelegationUpdate = {
  resource?: string;
  scopes?: ConfidentialDelegationScope[];
  enabled?: boolean;
};

export const confidentialDelegationService = {
  async list(): Promise<ConfidentialDelegationMapping[]> {
    return ConfidentialDelegationMappingListSchema.parse(await api.get<unknown>(endpoint));
  },

  async create(input: ConfidentialDelegationFormValues): Promise<ConfidentialDelegationMapping> {
    const response = await api.post<unknown>(endpoint, {
      source_domain: input.sourceDomain,
      product: input.product,
      resource: input.resource,
      scopes: input.scopes,
      enabled: input.enabled,
    });
    return ConfidentialDelegationMappingSchema.parse(response);
  },

  async update(
    mappingId: string,
    input: ConfidentialDelegationUpdate,
  ): Promise<ConfidentialDelegationMapping> {
    const response = await api.patch<unknown>(
      `${endpoint}/${encodeURIComponent(mappingId)}`,
      input,
    );
    return ConfidentialDelegationMappingSchema.parse(response);
  },

  async remove(mappingId: string): Promise<void> {
    await api.delete<unknown>(`${endpoint}/${encodeURIComponent(mappingId)}`);
  },
};
