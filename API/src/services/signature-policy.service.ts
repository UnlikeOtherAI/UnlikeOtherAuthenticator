import type { PrismaClient } from '@prisma/client';

import { getAdminPrisma } from '../db/prisma.js';
import { AppError } from '../utils/errors.js';

export type SignaturePolicyPrisma = Pick<
  PrismaClient,
  'domainSignatureSettings' | 'agreement' | 'agreementSignature'
>;

export type RequiredAgreementVersion = {
  agreementId: string;
  agreementVersionId: string;
  version: number;
  title: string;
  displayOrder: number;
  signingMethod: 'CLICKWRAP' | 'TYPED_NAME';
  acceptanceStatement: string;
  sourcePdfSha256: string;
};

export type SignaturePolicyEvaluation = {
  enabled: boolean;
  policyRevision: number;
  complete: boolean;
  required: RequiredAgreementVersion[];
  missing: RequiredAgreementVersion[];
};

function policyPrisma(deps?: { prisma?: SignaturePolicyPrisma }): SignaturePolicyPrisma {
  return deps?.prisma ?? (getAdminPrisma() as unknown as SignaturePolicyPrisma);
}

function invalidPolicy(): never {
  throw new AppError('INTERNAL', 500, 'SIGNATURE_POLICY_INVALID');
}

export async function evaluateSignaturePolicy(
  params: { domain: string; userId: string; now?: Date },
  deps?: { prisma?: SignaturePolicyPrisma },
): Promise<SignaturePolicyEvaluation> {
  const prisma = policyPrisma(deps);
  const now = params.now ?? new Date();
  const settings = await prisma.domainSignatureSettings.findUnique({
    where: { domain: params.domain },
    select: { enabled: true, policyRevision: true, retentionDays: true },
  });

  if (!settings?.enabled) {
    return {
      enabled: false,
      policyRevision: settings?.policyRevision ?? 0,
      complete: true,
      required: [],
      missing: [],
    };
  }

  // Retention must be an explicit domain decision before enablement. Treat a row that
  // bypassed the Admin enable guard as invalid and fail closed.
  if (settings.retentionDays == null || settings.retentionDays <= 0) {
    return invalidPolicy();
  }

  const agreements = await prisma.agreement.findMany({
    where: { domain: params.domain, requiredForAccess: true },
    orderBy: [{ displayOrder: 'asc' }, { createdAt: 'asc' }],
    select: {
      id: true,
      displayOrder: true,
      versions: {
        where: { status: 'PUBLISHED', effectiveAt: { lte: now } },
        orderBy: { version: 'desc' },
        take: 1,
        select: {
          id: true,
          version: true,
          title: true,
          signingMethod: true,
          acceptanceStatement: true,
          sourcePdfSha256: true,
        },
      },
    },
  });

  if (agreements.length === 0 || agreements.some((agreement) => agreement.versions.length !== 1)) {
    return invalidPolicy();
  }

  const required = agreements.map<RequiredAgreementVersion>((agreement) => {
    const version = agreement.versions[0];
    if (!version) return invalidPolicy();
    return {
      agreementId: agreement.id,
      agreementVersionId: version.id,
      version: version.version,
      title: version.title,
      displayOrder: agreement.displayOrder,
      signingMethod: version.signingMethod,
      acceptanceStatement: version.acceptanceStatement,
      sourcePdfSha256: version.sourcePdfSha256,
    };
  });

  const signatureRows = await prisma.agreementSignature.findMany({
    where: {
      domain: params.domain,
      userId: params.userId,
      agreementVersionId: { in: required.map((item) => item.agreementVersionId) },
    },
    select: {
      agreementVersionId: true,
      revocation: { select: { id: true } },
    },
  });
  const satisfiedVersionIds = new Set(
    signatureRows
      .filter((signature) => signature.revocation == null)
      .map((signature) => signature.agreementVersionId),
  );
  const missing = required.filter(
    (requirement) => !satisfiedVersionIds.has(requirement.agreementVersionId),
  );

  return {
    enabled: true,
    policyRevision: settings.policyRevision,
    complete: missing.length === 0,
    required,
    missing,
  };
}
