import { authEndpoints } from './schema.auth.js';
import { nativeAppEndpoints } from './schema.native-apps.js';
import { avatarEndpoints } from './schema.avatars.js';
import { billingEndpoints } from './schema.billing.js';
import { configDebugEndpoints } from './schema.config-debug.js';
import { integrationsEndpoints } from './schema.integrations.js';
import { internalAdminEndpoints } from './schema.internal-admin.js';
import { oauthAccountEndpoints } from './schema.oauth-account.js';
import { oauthEndpoints } from './schema.oauth.js';
import { withOrgContract } from './schema.org-contract.js';
import { orgInvitationEndpoints } from './schema.org-invitations.js';
import { orgEndpoints, orgGroupEndpoints, orgTeamMemberEndpoints } from './schema.org.js';
import { appEndpoints, baseEndpoints, domainEndpoints, emailEndpoints } from './schema.platform.js';
import { settingsEndpoints } from './schema.settings.js';
import { signatureEndpoints } from './schema.signatures.js';

export type EndpointSchema = {
  method: string;
  path: string;
  description: string;
  auth?: string;
  query?: Record<string, string>;
  body?: Record<string, string>;
  response?: Record<string, string>;
  notes?: string;
};

// The /org/* slices are concatenated in the exact order the endpoints were
// declared in, because this array is the published order of GET /api.
const orgContractEndpoints: EndpointSchema[] = withOrgContract([
  ...orgEndpoints,
  ...orgInvitationEndpoints,
  ...orgTeamMemberEndpoints,
  ...orgGroupEndpoints,
]);

export const endpoints: EndpointSchema[] = [
  ...nativeAppEndpoints,
  ...baseEndpoints,
  ...configDebugEndpoints,
  ...authEndpoints,
  ...billingEndpoints,
  ...appEndpoints,
  ...emailEndpoints,
  ...domainEndpoints,
  ...avatarEndpoints,
  ...settingsEndpoints,
  ...orgContractEndpoints,
  ...integrationsEndpoints,
  ...internalAdminEndpoints,
  ...oauthEndpoints,
  ...oauthAccountEndpoints,
  ...signatureEndpoints,
];
