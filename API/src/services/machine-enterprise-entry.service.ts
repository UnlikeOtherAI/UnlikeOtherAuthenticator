import { MachineBinding } from './machine-contract.js';
import { fingerprintClientConfig } from './client-config-fingerprint.service.js';
import type { ClientConfig } from './config.service.js';
import { machineClock, machineTransaction } from './machine-authority.service.js';
import { machineRefused } from './machine-crypto.js';

/** Starts existing HUMAN SSO for an exact key-proven intent. This grants no machine authority. */
export async function machineEnterpriseConnection(requestId: string, config: ClientConfig, configUrl: string) {
  return machineTransaction(async tx => {
    const request = await tx.machineAuthorizationRequest.findUnique({ where: { id: requestId } });
    if (!request || request.clientDomain !== config.domain || request.configUrl !== configUrl ||
      request.configFingerprint !== fingerprintClientConfig(config) || !request.proofHash ||
      request.expiresAt <= await machineClock(tx) || request.consentedAt || request.deniedAt) machineRefused();
    const binding = MachineBinding.parse(request.binding);
    const policy = await tx.orgSsoPolicy.findUnique({ where: { clientDomain_orgId: {
      clientDomain: config.domain, orgId: binding.organization_id } } });
    if (!policy || policy.enforcement === 'off') return undefined;
    let governed = policy.enforcement === 'required_for_all_members';
    if (!governed) {
      const user = await tx.user.findUnique({ where: { id: binding.subject }, select: { email: true } });
      const emailDomain = user?.email?.split('@')[1]?.toLowerCase();
      governed = Boolean(emailDomain && await tx.organisationEmailDomain.findFirst({ where: {
        clientDomain: config.domain, orgId: binding.organization_id, emailDomain, verifiedAt: { not: null },
      }, select: { id: true } }));
    }
    if (!governed) return undefined;
    const connections = await tx.orgSsoConnection.findMany({ where: {
      clientDomain: config.domain, orgId: binding.organization_id, status: 'active',
    }, select: { id: true }, take: 2 });
    // Ambiguous enterprise routing must never fall back to independent authentication.
    if (connections.length !== 1) machineRefused(409, 'MACHINE_PRODUCT_UNAVAILABLE');
    return connections[0].id;
  });
}
