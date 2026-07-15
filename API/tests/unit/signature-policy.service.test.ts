import { describe, expect, it, vi } from 'vitest';

import {
  evaluateSignaturePolicy,
  type SignaturePolicyPrisma,
} from '../../src/services/signature-policy.service.js';

type TestAgreement = {
  id: string;
  displayOrder: number;
  versions: Array<{
    id: string;
    version: number;
    title: string;
    signingMethod: 'CLICKWRAP' | 'TYPED_NAME';
    acceptanceStatement: string;
    sourcePdfSha256: string;
  }>;
};

function agreement(id: string, version: number, displayOrder: number): TestAgreement {
  return {
    id,
    displayOrder,
    versions: [
      {
        id: `${id}-v${version}`,
        version,
        title: `${id} terms`,
        signingMethod: version % 2 === 0 ? 'TYPED_NAME' : 'CLICKWRAP',
        acceptanceStatement: `I accept ${id} v${version}`,
        sourcePdfSha256: String(version).repeat(64),
      },
    ],
  };
}

function mockPrisma(params?: {
  settings?: { enabled: boolean; policyRevision: number; retentionDays: number | null } | null;
  agreements?: TestAgreement[];
  signatures?: Array<{ agreementVersionId: string; revocation: { id: string } | null }>;
}) {
  const db = {
    domainSignatureSettings: {
      findUnique: vi.fn(async () => params?.settings ?? null),
    },
    agreement: {
      findMany: vi.fn(async () => params?.agreements ?? []),
    },
    agreementSignature: {
      findMany: vi.fn(async () => params?.signatures ?? []),
    },
  };
  return db as unknown as SignaturePolicyPrisma & {
    domainSignatureSettings: { findUnique: ReturnType<typeof vi.fn> };
    agreement: { findMany: ReturnType<typeof vi.fn> };
    agreementSignature: { findMany: ReturnType<typeof vi.fn> };
  };
}

describe('signature policy evaluation', () => {
  it('preserves existing behavior when the domain has no signature settings', async () => {
    const prisma = mockPrisma();

    await expect(
      evaluateSignaturePolicy({ domain: 'plain.example.com', userId: 'user-1' }, { prisma }),
    ).resolves.toEqual({
      enabled: false,
      policyRevision: 0,
      complete: true,
      required: [],
      missing: [],
    });
    expect(prisma.agreement.findMany).not.toHaveBeenCalled();
    expect(prisma.agreementSignature.findMany).not.toHaveBeenCalled();
  });

  it('preserves existing behavior for an explicitly disabled domain', async () => {
    const prisma = mockPrisma({
      settings: { enabled: false, policyRevision: 7, retentionDays: null },
    });

    await expect(
      evaluateSignaturePolicy({ domain: 'plain.example.com', userId: 'user-1' }, { prisma }),
    ).resolves.toMatchObject({ enabled: false, policyRevision: 7, complete: true });
    expect(prisma.agreement.findMany).not.toHaveBeenCalled();
  });

  it('fails closed when an enabled domain has no explicit retention decision', async () => {
    const prisma = mockPrisma({
      settings: { enabled: true, policyRevision: 1, retentionDays: null },
    });

    await expect(
      evaluateSignaturePolicy({ domain: 'signed.example.com', userId: 'user-1' }, { prisma }),
    ).rejects.toMatchObject({ message: 'SIGNATURE_POLICY_INVALID', statusCode: 500 });
  });

  it('fails closed when an enabled domain has no active required agreement', async () => {
    const prisma = mockPrisma({
      settings: { enabled: true, policyRevision: 1, retentionDays: 365 },
      agreements: [],
    });

    await expect(
      evaluateSignaturePolicy({ domain: 'signed.example.com', userId: 'user-1' }, { prisma }),
    ).rejects.toMatchObject({ message: 'SIGNATURE_POLICY_INVALID', statusCode: 500 });
  });

  it('reports missing versions in domain display order and scopes signature lookup', async () => {
    const prisma = mockPrisma({
      settings: { enabled: true, policyRevision: 4, retentionDays: 730 },
      agreements: [agreement('nda', 1, 10), agreement('terms', 2, 20)],
      signatures: [{ agreementVersionId: 'nda-v1', revocation: null }],
    });
    const now = new Date('2026-07-15T12:00:00.000Z');

    const result = await evaluateSignaturePolicy(
      { domain: 'signed.example.com', userId: 'user-7', now },
      { prisma },
    );

    expect(result).toMatchObject({ enabled: true, policyRevision: 4, complete: false });
    expect(result.required.map((item) => item.agreementVersionId)).toEqual(['nda-v1', 'terms-v2']);
    expect(result.missing.map((item) => item.agreementVersionId)).toEqual(['terms-v2']);
    expect(prisma.agreement.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { domain: 'signed.example.com', requiredForAccess: true } }),
    );
    expect(prisma.agreementSignature.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          domain: 'signed.example.com',
          userId: 'user-7',
          agreementVersionId: { in: ['nda-v1', 'terms-v2'] },
        },
      }),
    );
  });

  it('does not count a revoked signature as satisfying the current version', async () => {
    const prisma = mockPrisma({
      settings: { enabled: true, policyRevision: 2, retentionDays: 365 },
      agreements: [agreement('terms', 1, 0)],
      signatures: [{ agreementVersionId: 'terms-v1', revocation: { id: 'revoked-1' } }],
    });

    const result = await evaluateSignaturePolicy(
      { domain: 'signed.example.com', userId: 'user-1' },
      { prisma },
    );

    expect(result.complete).toBe(false);
    expect(result.missing).toHaveLength(1);
  });

  it('is complete only when every active required version has a non-revoked signature', async () => {
    const prisma = mockPrisma({
      settings: { enabled: true, policyRevision: 9, retentionDays: 365 },
      agreements: [agreement('nda', 3, 0), agreement('terms', 4, 1)],
      signatures: [
        { agreementVersionId: 'nda-v3', revocation: null },
        { agreementVersionId: 'terms-v4', revocation: null },
      ],
    });

    const result = await evaluateSignaturePolicy(
      { domain: 'signed.example.com', userId: 'user-1' },
      { prisma },
    );

    expect(result.complete).toBe(true);
    expect(result.missing).toEqual([]);
  });
});
