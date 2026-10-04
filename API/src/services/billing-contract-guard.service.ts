import { BillingOrganisationContractStatus, type Prisma } from '@prisma/client';

import { AppError } from '../utils/errors.js';

async function currentContractTerm(
  tx: Prisma.TransactionClient,
  params: { organisationId: string; serviceId: string; assignmentId?: string },
) {
  const contracts = await tx.billingOrganisationContract.findMany({
    where: {
      orgId: params.organisationId,
      status: BillingOrganisationContractStatus.ACTIVE,
    },
    select: {
      versions: {
        where: { serviceTerms: { some: {} } },
        orderBy: [{ effectiveFromMonth: 'desc' }, { version: 'desc' }],
        select: {
          effectiveFromMonth: true,
          serviceTerms: {
            where: {
              serviceId: params.serviceId,
              ...(params.assignmentId ? { tariffAssignmentId: params.assignmentId } : {}),
            },
            take: 1,
            select: { id: true },
          },
        },
      },
    },
  });
  const currentMonth = new Date().toISOString().slice(0, 7);
  for (const contract of contracts) {
    const current = contract.versions.find((version) =>
      version.effectiveFromMonth <= currentMonth);
    const future = contract.versions.find((version) =>
      version.effectiveFromMonth > currentMonth && version.serviceTerms.length > 0);
    if (current?.serviceTerms[0] || future?.serviceTerms[0]) {
      return current?.serviceTerms[0] ?? future?.serviceTerms[0];
    }
  }
  return null;
}

export async function assertContractAssignmentWriteAllowed(
  tx: Prisma.TransactionClient,
  params: { serviceId: string; organisationId: string; teamId: string | null },
): Promise<void> {
  if (await currentContractTerm(tx, params)) {
    throw new AppError(
      'BAD_REQUEST',
      409,
      params.teamId
        ? 'BILLING_CONTRACT_TEAM_OVERRIDE_FORBIDDEN'
        : 'BILLING_CONTRACT_ORGANISATION_OVERRIDE_FORBIDDEN',
    );
  }
}

export async function assertContractAssignmentRemovalAllowed(
  tx: Prisma.TransactionClient,
  assignmentId: string,
): Promise<void> {
  const assignment = await tx.billingTariffAssignment.findUnique({
    where: { id: assignmentId },
    select: { serviceId: true, orgId: true },
  });
  if (
    assignment &&
    (await currentContractTerm(tx, {
      organisationId: assignment.orgId,
      serviceId: assignment.serviceId,
      assignmentId,
    }))
  ) {
    throw new AppError('BAD_REQUEST', 409, 'BILLING_CONTRACT_ASSIGNMENT_LOCKED');
  }
}
