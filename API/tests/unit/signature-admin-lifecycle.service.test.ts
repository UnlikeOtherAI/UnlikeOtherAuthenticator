import { PDFDocument } from 'pdf-lib';
import { describe, expect, it, vi } from 'vitest';

import { parseEnv } from '../../src/config/env.js';
import {
  publishAgreementVersion,
  withdrawAgreementVersion,
} from '../../src/services/signature-agreement-publication.service.js';
import {
  readAgreementVersionSource,
  updateDraftAgreementVersion,
  uploadDraftAgreementVersion,
} from '../../src/services/signature-agreement-lifecycle.service.js';
import {
  assertSignatureRuntimeReady,
  createAgreement,
  updateAgreement,
  updateSignatureSettings,
} from '../../src/services/signature-admin.service.js';

const SHARED_SECRET = 'test-shared-secret-that-is-at-least-thirty-two-bytes';
const NOW = new Date('2026-07-15T12:00:00.000Z');

function testEnv(overrides: Record<string, string> = {}) {
  return parseEnv({ NODE_ENV: 'test', SHARED_SECRET, ...overrides });
}

function readyEnv() {
  const privateKey = JSON.stringify({
    kty: 'RSA',
    kid: 'evidence-current',
    n: 'modulus',
    e: 'AQAB',
    d: 'private',
    alg: 'RS256',
    use: 'sig',
  });
  const publicKeys = JSON.stringify({
    keys: [
      {
        kty: 'RSA',
        kid: 'evidence-current',
        n: 'modulus',
        e: 'AQAB',
        alg: 'RS256',
        use: 'sig',
      },
    ],
  });
  return testEnv({
    SIGNATURE_STORAGE_PROVIDER: 'filesystem',
    SIGNATURE_FILESYSTEM_ROOT: '/tmp/uoa-signature-test',
    SIGNATURE_MALWARE_SCANNER: 'clamav',
    SIGNATURE_EVIDENCE_PRIVATE_JWK: privateKey,
    SIGNATURE_EVIDENCE_PUBLIC_JWKS_JSON: publicKeys,
  });
}

function agreementRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'agreement-1',
    domain: 'example.com',
    title: 'Terms',
    description: null,
    displayOrder: 0,
    requiredForAccess: true,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function versionRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'version-1',
    agreementId: 'agreement-1',
    version: 1,
    title: 'Terms v1',
    originalFilename: 'terms.pdf',
    sourceStorageKey: 'sources/example.com/agreement-1/version-1/source.pdf',
    sourcePdfSha256: 'a'.repeat(64),
    signingMethod: 'CLICKWRAP',
    acceptanceStatement: 'I agree.',
    status: 'DRAFT',
    publishedAt: null,
    effectiveAt: null,
    publishedByEmail: null,
    createdAt: NOW,
    agreement: agreementRow(),
    ...overrides,
  };
}

function fakePrisma() {
  const prisma = {
    clientDomain: { findUnique: vi.fn() },
    domainSignatureSettings: {
      findUnique: vi.fn(),
      upsert: vi.fn(),
      update: vi.fn(),
    },
    agreement: {
      findFirst: vi.fn(),
      findMany: vi.fn(),
      count: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
    },
    agreementVersion: {
      findFirst: vi.fn(),
      count: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
      delete: vi.fn(),
    },
    signatureAuditEvent: { create: vi.fn().mockResolvedValue({}) },
    adminAuditLog: { create: vi.fn().mockResolvedValue({}) },
    $transaction: vi.fn(),
  };
  prisma.$transaction.mockImplementation(async (callback: (tx: typeof prisma) => unknown) =>
    callback(prisma),
  );
  return prisma;
}

async function validPdf(): Promise<Buffer> {
  const document = await PDFDocument.create();
  document.addPage([300, 400]);
  return Buffer.from(await document.save({ useObjectStreams: false }));
}

describe('signature admin settings and agreements', () => {
  it('fails closed until storage, malware scanning, and both evidence key sides are configured', () => {
    expect(() => assertSignatureRuntimeReady(testEnv())).toThrowError(
      'SIGNATURE_STORAGE_NOT_CONFIGURED',
    );
    expect(() =>
      assertSignatureRuntimeReady(
        testEnv({
          SIGNATURE_STORAGE_PROVIDER: 'filesystem',
          SIGNATURE_FILESYSTEM_ROOT: '/tmp/uoa-signature-test',
        }),
      ),
    ).toThrowError('SIGNATURE_MALWARE_SCANNER_NOT_CONFIGURED');
    expect(() =>
      assertSignatureRuntimeReady(
        testEnv({
          SIGNATURE_STORAGE_PROVIDER: 'filesystem',
          SIGNATURE_FILESYSTEM_ROOT: '/tmp/uoa-signature-test',
          SIGNATURE_MALWARE_SCANNER: 'clamav',
        }),
      ),
    ).toThrowError('SIGNATURE_EVIDENCE_KEYS_NOT_CONFIGURED');
    expect(() => assertSignatureRuntimeReady(readyEnv())).not.toThrow();
  });

  it('enables only with explicit retention and an active published required version', async () => {
    const prisma = fakePrisma();
    prisma.clientDomain.findUnique.mockResolvedValue({ domain: 'example.com' });
    prisma.domainSignatureSettings.findUnique.mockResolvedValue({
      domain: 'example.com',
      enabled: false,
      retentionDays: null,
      policyRevision: 0,
    });
    prisma.agreement.count.mockResolvedValue(1);
    prisma.domainSignatureSettings.upsert.mockResolvedValue({
      domain: 'example.com',
      enabled: true,
      retentionDays: 365,
      policyRevision: 1,
    });

    const settings = await updateSignatureSettings(
      {
        domain: 'Example.COM',
        enabled: true,
        retentionDays: 365,
        actorEmail: 'admin@example.com',
      },
      { prisma: prisma as never, env: readyEnv(), now: () => NOW },
    );

    expect(settings.enabled).toBe(true);
    expect(prisma.agreement.count).toHaveBeenCalledWith({
      where: expect.objectContaining({ domain: 'example.com', requiredForAccess: true }),
    });
    expect(prisma.signatureAuditEvent.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ action: 'signature.settings_updated' }),
    });

    prisma.agreement.count.mockResolvedValue(0);
    await expect(
      updateSignatureSettings(
        {
          domain: 'example.com',
          enabled: true,
          retentionDays: 365,
          actorEmail: 'admin@example.com',
        },
        { prisma: prisma as never, env: readyEnv(), now: () => NOW },
      ),
    ).rejects.toThrowError('SIGNATURE_PUBLISHED_REQUIREMENT_REQUIRED');
  });

  it('rejects retention outside the documented 1 to 36,500 day range', async () => {
    const prisma = fakePrisma();
    for (const retentionDays of [0, 36_501]) {
      await expect(
        updateSignatureSettings(
          {
            domain: 'example.com',
            enabled: false,
            retentionDays,
            actorEmail: 'admin@example.com',
          },
          { prisma: prisma as never, env: readyEnv(), now: () => NOW },
        ),
      ).rejects.toThrowError('INVALID_SIGNATURE_RETENTION');
    }
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('creates a domain-scoped agreement and writes both audit records atomically', async () => {
    const prisma = fakePrisma();
    prisma.clientDomain.findUnique.mockResolvedValue({ domain: 'example.com' });
    prisma.domainSignatureSettings.upsert.mockResolvedValue({});
    prisma.agreement.create.mockResolvedValue(agreementRow());

    await createAgreement(
      {
        domain: 'example.com',
        title: 'Terms',
        description: null,
        displayOrder: 0,
        requiredForAccess: true,
        actorEmail: 'admin@example.com',
      },
      { prisma: prisma as never },
    );

    expect(prisma.agreement.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ domain: 'example.com', title: 'Terms' }),
    });
    expect(prisma.signatureAuditEvent.create).toHaveBeenCalledOnce();
    expect(prisma.adminAuditLog.create).toHaveBeenCalledOnce();
  });

  it('cannot remove the last active requirement while the domain remains enabled', async () => {
    const prisma = fakePrisma();
    prisma.agreement.findFirst.mockResolvedValue(agreementRow({ requiredForAccess: true }));
    prisma.domainSignatureSettings.findUnique.mockResolvedValue({ enabled: true });
    prisma.agreement.count.mockResolvedValue(0);

    await expect(
      updateAgreement(
        {
          domain: 'example.com',
          agreementId: 'agreement-1',
          title: 'Terms',
          description: null,
          displayOrder: 0,
          requiredForAccess: false,
          actorEmail: 'admin@example.com',
        },
        { prisma: prisma as never, now: () => NOW },
      ),
    ).rejects.toThrowError('LAST_REQUIRED_AGREEMENT_CANNOT_BE_REMOVED');
    expect(prisma.agreement.update).not.toHaveBeenCalled();
  });
});

describe('agreement draft file lifecycle', () => {
  it('validates, malware-scans, hashes, stores, and audits a new monotonically numbered draft', async () => {
    const source = await validPdf();
    const prisma = fakePrisma();
    prisma.agreement.findFirst.mockResolvedValue(agreementRow());
    prisma.agreement.update.mockResolvedValue(agreementRow());
    prisma.agreementVersion.findFirst.mockResolvedValue({ version: 2 });
    prisma.agreementVersion.create.mockImplementation(async ({ data }) => ({ ...versionRow(), ...data }));
    const storage = { putImmutable: vi.fn(), read: vi.fn(), deleteDraft: vi.fn() };
    const scanner = { scanPdf: vi.fn() };

    const version = await uploadDraftAgreementVersion(
      {
        domain: 'example.com',
        agreementId: 'agreement-1',
        title: 'Terms v3',
        originalFilename: 'terms-v3.pdf',
        signingMethod: 'CLICKWRAP',
        acceptanceStatement: 'I agree.',
        sourcePdf: source,
        actorEmail: 'admin@example.com',
      },
      {
        prisma: prisma as never,
        storage,
        scanner,
        env: testEnv(),
        idFactory: () => 'version-3-id',
        now: () => NOW,
      },
    );

    expect(scanner.scanPdf).toHaveBeenCalledWith(source);
    expect(storage.putImmutable).toHaveBeenCalledWith(
      'sources/example.com/agreement-1/version-3-id/source.pdf',
      source,
      'application/pdf',
    );
    expect(version).toMatchObject({ id: 'version-3-id', version: 3, status: 'DRAFT' });
    expect(prisma.agreementVersion.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ version: 3, sourcePdfSha256: expect.stringMatching(/^[a-f0-9]{64}$/u) }),
    });
  });

  it('removes an unreferenced object when database persistence fails', async () => {
    const prisma = fakePrisma();
    prisma.agreement.findFirst.mockResolvedValue(agreementRow());
    prisma.agreement.update.mockResolvedValue(agreementRow());
    prisma.agreementVersion.findFirst.mockResolvedValue(null);
    prisma.agreementVersion.create.mockRejectedValue(new Error('database failed'));
    const storage = { putImmutable: vi.fn(), read: vi.fn(), deleteDraft: vi.fn() };

    await expect(
      uploadDraftAgreementVersion(
        {
          domain: 'example.com',
          agreementId: 'agreement-1',
          title: 'Terms',
          originalFilename: 'terms.pdf',
          signingMethod: 'CLICKWRAP',
          acceptanceStatement: 'I agree.',
          sourcePdf: await validPdf(),
          actorEmail: 'admin@example.com',
        },
        {
          prisma: prisma as never,
          storage,
          scanner: { scanPdf: vi.fn() },
          env: testEnv(),
          idFactory: () => 'failed-version-id',
        },
      ),
    ).rejects.toThrowError('database failed');
    expect(storage.deleteDraft).toHaveBeenCalledWith(
      'sources/example.com/agreement-1/failed-version-id/source.pdf',
    );
  });

  it('refuses every metadata edit after publication', async () => {
    const prisma = fakePrisma();
    prisma.agreementVersion.findFirst.mockResolvedValue(versionRow({ status: 'PUBLISHED' }));
    await expect(
      updateDraftAgreementVersion(
        {
          domain: 'example.com',
          agreementId: 'agreement-1',
          versionId: 'version-1',
          title: 'Changed',
          signingMethod: 'CLICKWRAP',
          acceptanceStatement: 'Changed.',
          actorEmail: 'admin@example.com',
        },
        { prisma: prisma as never },
      ),
    ).rejects.toThrowError('PUBLISHED_VERSION_IMMUTABLE');
    expect(prisma.agreementVersion.update).not.toHaveBeenCalled();
  });

  it('detects private-object tampering before returning source bytes', async () => {
    const prisma = fakePrisma();
    prisma.agreementVersion.findFirst.mockResolvedValue(versionRow());
    await expect(
      readAgreementVersionSource(
        { domain: 'example.com', agreementId: 'agreement-1', versionId: 'version-1' },
        {
          prisma: prisma as never,
          storage: {
            putImmutable: vi.fn(),
            read: vi.fn().mockResolvedValue(Buffer.from('tampered')),
            deleteDraft: vi.fn(),
          },
        },
      ),
    ).rejects.toThrowError('SIGNATURE_SOURCE_HASH_MISMATCH');
  });
});

describe('agreement publication lifecycle', () => {
  it('locks the agreement, supersedes the old version, publishes the draft, and increments policy', async () => {
    const prisma = fakePrisma();
    prisma.agreement.findFirst.mockResolvedValue(agreementRow());
    prisma.agreement.update.mockResolvedValue(agreementRow());
    prisma.agreementVersion.findFirst.mockResolvedValue(versionRow());
    prisma.domainSignatureSettings.findUnique.mockResolvedValue({ enabled: true });
    prisma.agreementVersion.updateMany.mockResolvedValue({ count: 1 });
    prisma.agreementVersion.update.mockResolvedValue(
      versionRow({ status: 'PUBLISHED', publishedAt: NOW, effectiveAt: NOW }),
    );
    prisma.domainSignatureSettings.update.mockResolvedValue({});

    const published = await publishAgreementVersion(
      {
        domain: 'example.com',
        agreementId: 'agreement-1',
        versionId: 'version-1',
        effectiveAt: NOW,
        actorEmail: 'admin@example.com',
      },
      { prisma: prisma as never, now: () => NOW },
    );

    expect(published.status).toBe('PUBLISHED');
    expect(prisma.agreement.update).toHaveBeenCalledBefore(prisma.agreementVersion.findFirst);
    expect(prisma.agreementVersion.updateMany).toHaveBeenCalledWith({
      where: { agreementId: 'agreement-1', status: 'PUBLISHED' },
      data: { status: 'SUPERSEDED' },
    });
    expect(prisma.domainSignatureSettings.update).toHaveBeenCalledWith({
      where: { domain: 'example.com' },
      data: { policyRevision: { increment: 1 } },
    });
  });

  it('does not withdraw the only required version while the domain is enabled', async () => {
    const prisma = fakePrisma();
    prisma.agreementVersion.findFirst.mockResolvedValue(
      versionRow({ status: 'PUBLISHED', agreement: agreementRow({ requiredForAccess: true }) }),
    );
    prisma.domainSignatureSettings.findUnique.mockResolvedValue({ enabled: true });

    await expect(
      withdrawAgreementVersion(
        {
          domain: 'example.com',
          agreementId: 'agreement-1',
          versionId: 'version-1',
          actorEmail: 'admin@example.com',
        },
        { prisma: prisma as never },
      ),
    ).rejects.toThrowError('REQUIRED_VERSION_CANNOT_BE_WITHDRAWN_WHILE_ENABLED');
    expect(prisma.agreementVersion.update).not.toHaveBeenCalled();
  });
});
