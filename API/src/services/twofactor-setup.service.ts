import type { PrismaClient } from '@prisma/client';

import { getAuthServiceIdentifier, getEnv, requireEnv } from '../config/env.js';
import { getPrisma } from '../db/prisma.js';
import { AppError } from '../utils/errors.js';
import { encryptTwoFaSecret } from '../utils/twofa-secret.js';
import type { ClientConfig } from './config.service.js';
import { buildTotpOtpAuthUri, generateTotpSecret } from './totp.service.js';
import { renderTotpQrSvg } from './totp-qr.service.js';
import { signTwoFaSetupToken } from './twofactor-setup-token.service.js';

type SetupPrisma = Pick<PrismaClient, 'user'>;

export type TwoFactorSetupResult = {
  otpauth_uri: string;
  qr_svg: string;
  setup_token: string;
  manual_secret: string;
};

type FinalizeContext = {
  authMethod: string;
  redirectUrl: string;
  rememberMe: boolean;
  requestAccess: boolean;
  codeChallenge?: string;
  codeChallengeMethod?: 'S256';
  orgId?: string;
  teamId?: string;
};

function prismaClient(deps?: { prisma?: SetupPrisma }): SetupPrisma {
  return deps?.prisma ?? (getPrisma() as unknown as SetupPrisma);
}

function issuerForConfig(config: ClientConfig): string {
  const logoText = config.ui_theme.logo.text?.trim();
  return logoText || config.ui_theme.logo.alt.trim() || config.domain;
}

async function buildSetupResult(params: {
  config: ClientConfig;
  email: string;
  secret: string;
  setupToken: string;
  renderTotpQrSvg: typeof renderTotpQrSvg;
}): Promise<TwoFactorSetupResult> {
  const otpauthUri = buildTotpOtpAuthUri({
    secret: params.secret,
    issuer: issuerForConfig(params.config),
    accountName: params.email,
  });
  const qrSvg = await params.renderTotpQrSvg({
    otpAuthUri: otpauthUri,
    logoUrl: params.config.ui_theme.logo.url,
  });

  return {
    otpauth_uri: otpauthUri,
    qr_svg: qrSvg,
    setup_token: params.setupToken,
    manual_secret: params.secret,
  };
}

export async function startTwoFactorSetup(
  params: {
    userId: string;
    credentialEpoch: number;
    config: ClientConfig;
    configUrl: string;
    finalize?: FinalizeContext;
  },
  deps?: {
    prisma?: SetupPrisma;
    generateTotpSecret?: typeof generateTotpSecret;
    encryptTwoFaSecret?: typeof encryptTwoFaSecret;
    renderTotpQrSvg?: typeof renderTotpQrSvg;
    signTwoFaSetupToken?: typeof signTwoFaSetupToken;
    sharedSecret?: string;
  },
): Promise<TwoFactorSetupResult> {
  if (!getEnv().DATABASE_URL) {
    throw new AppError('INTERNAL', 500, 'DATABASE_DISABLED');
  }

  const prisma = prismaClient(deps);
  const user = await prisma.user.findUnique({
    where: { id: params.userId },
    select: { email: true, twoFaEnabled: true, tokenVersion: true },
  });

  if (!user || user.twoFaEnabled || user.tokenVersion !== params.credentialEpoch) {
    throw new AppError('BAD_REQUEST', 400, 'TWOFA_SETUP_FAILED');
  }

  const sharedSecret = deps?.sharedSecret ?? requireEnv('SHARED_SECRET').SHARED_SECRET;
  const secret = (deps?.generateTotpSecret ?? generateTotpSecret)();
  const encryptedSecret = (deps?.encryptTwoFaSecret ?? encryptTwoFaSecret)({
    secret,
    sharedSecret,
  });
  const setupToken = await (deps?.signTwoFaSetupToken ?? signTwoFaSetupToken)({
    userId: params.userId,
    credentialEpoch: params.credentialEpoch,
    encryptedSecret,
    configUrl: params.configUrl,
    domain: params.config.domain,
    authMethod: params.finalize?.authMethod,
    redirectUrl: params.finalize?.redirectUrl,
    rememberMe: params.finalize?.rememberMe,
    requestAccess: params.finalize?.requestAccess,
    codeChallenge: params.finalize?.codeChallenge,
    codeChallengeMethod: params.finalize?.codeChallengeMethod,
    orgId: params.finalize?.orgId,
    teamId: params.finalize?.teamId,
    sharedSecret,
    audience: getAuthServiceIdentifier(),
  });

  return buildSetupResult({
    config: params.config,
    email: user.email,
    secret,
    setupToken,
    renderTotpQrSvg: deps?.renderTotpQrSvg ?? renderTotpQrSvg,
  });
}

export async function renderTwoFactorSetupFromTokenSecret(
  params: {
    userId: string;
    totpSecret: string;
    setupToken: string;
    config: ClientConfig;
  },
  deps?: { prisma?: SetupPrisma; renderTotpQrSvg?: typeof renderTotpQrSvg },
): Promise<TwoFactorSetupResult> {
  if (!getEnv().DATABASE_URL) {
    throw new AppError('INTERNAL', 500, 'DATABASE_DISABLED');
  }

  const prisma = prismaClient(deps);
  const user = await prisma.user.findUnique({
    where: { id: params.userId },
    select: { email: true, twoFaEnabled: true },
  });

  if (!user || user.twoFaEnabled) {
    throw new AppError('BAD_REQUEST', 400, 'TWOFA_SETUP_FAILED');
  }

  return buildSetupResult({
    config: params.config,
    email: user.email,
    secret: params.totpSecret,
    setupToken: params.setupToken,
    renderTotpQrSvg: deps?.renderTotpQrSvg ?? renderTotpQrSvg,
  });
}
