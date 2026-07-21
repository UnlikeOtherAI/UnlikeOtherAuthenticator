import { BillingOrganisationContractStatus, type Prisma } from '@prisma/client';

import { AppError } from '../utils/errors.js';

async function currentContractTerm(
  tx: Prisma.TransactionClient,
  params: { organisationId: string; serviceId: string; assignmentId?: string },
) {
  const contract = await tx.billingOrganisationContract.findFirst({
    where: {
      orgId: params.organisationId,
      status: BillingOrganisationContractStatus.ACTIVE,
    },
    select: {
      versions: {
        where: { serviceTerms: { some: {} } },
        orderBy: [{ effectiveFromMonth: 'desc' }, { version: 'desc' }],
        take: 1,
        select: {
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
  return contract?.versions[0]?.serviceTerms[0] ?? null;
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
