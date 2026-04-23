import type {
  GetIdentityDkimAttributesCommandOutput,
  GetIdentityVerificationAttributesCommandOutput,
} from '@aws-sdk/client-ses';

import { getEnv } from '../config/env.js';
import { AppError } from '../utils/errors.js';

export type SesRegistration = {
  verification: { record: string; status: string };
  dkim: { cname: string; value: string }[];
};

export type SesStatus = {
  verification: string;
  dkim: string;
};

type SesModule = typeof import('@aws-sdk/client-ses');
type SesClient = InstanceType<SesModule['SESClient']>;

let runtimePromise: Promise<{ mod: SesModule; client: SesClient }> | undefined;

export function hasDedicatedSesAdminCredentials(): boolean {
  const env = getEnv();
  return Boolean(env.AWS_SES_ADMIN_ACCESS_KEY_ID && env.AWS_SES_ADMIN_SECRET_ACCESS_KEY);
}

export function hasSesAdminRuntimeCredentials(): boolean {
  const env = getEnv();
  return Boolean(
    (env.AWS_SES_ADMIN_ACCESS_KEY_ID && env.AWS_SES_ADMIN_SECRET_ACCESS_KEY) ||
      (env.AWS_ACCESS_KEY_ID && env.AWS_SECRET_ACCESS_KEY),
  );
}

async function getRuntime(): Promise<{ mod: SesModule; client: SesClient }> {
  if (!runtimePromise) {
    runtimePromise = (async () => {
      const env = getEnv();
      const mod = await import('@aws-sdk/client-ses');
      const accessKeyId = env.AWS_SES_ADMIN_ACCESS_KEY_ID ?? env.AWS_ACCESS_KEY_ID;
      const secretAccessKey = env.AWS_SES_ADMIN_SECRET_ACCESS_KEY ?? env.AWS_SECRET_ACCESS_KEY;
      const credentials =
        accessKeyId && secretAccessKey ? { accessKeyId, secretAccessKey } : undefined;

      return {
        mod,
        client: new mod.SESClient({
          region: env.AWS_SES_ADMIN_REGION ?? env.AWS_REGION ?? 'eu-west-1',
          credentials,
        }),
      };
    })();
  }

  return runtimePromise;
}

function dkimStatus(output: GetIdentityDkimAttributesCommandOutput, domain: string): string {
  const attrs = output.DkimAttributes?.[domain];
  if (!attrs) return 'Pending';
  if (attrs.DkimVerificationStatus) return attrs.DkimVerificationStatus;
  return attrs.DkimTokens?.length ? 'Pending' : 'Failed';
}

function verificationStatus(
  output: GetIdentityVerificationAttributesCommandOutput,
  domain: string,
): string {
  return output.VerificationAttributes?.[domain]?.VerificationStatus ?? 'Pending';
}

export async function registerSesSender(domain: string): Promise<SesRegistration> {
  try {
    const { client, mod } = await getRuntime();
    const identity = await client.send(new mod.VerifyDomainIdentityCommand({ Domain: domain }));
    const dkim = await client.send(new mod.VerifyDomainDkimCommand({ Domain: domain }));
    await client.send(new mod.SetIdentityDkimEnabledCommand({ Identity: domain, DkimEnabled: true }));

    return {
      verification: {
        record: `_amazonses.${domain} TXT "${identity.VerificationToken ?? ''}"`,
        status: 'Pending',
      },
      dkim: (dkim.DkimTokens ?? []).map((token) => ({
        cname: `${token}._domainkey.${domain}`,
        value: `${token}.dkim.amazonses.com`,
      })),
    };
  } catch {
    throw new AppError('INTERNAL', 500, 'SES_REGISTRATION_FAILED');
  }
}

export async function getSesStatus(domain: string): Promise<SesStatus> {
  try {
    const { client, mod } = await getRuntime();
    const [verification, dkim] = await Promise.all([
      client.send(new mod.GetIdentityVerificationAttributesCommand({ Identities: [domain] })),
      client.send(new mod.GetIdentityDkimAttributesCommand({ Identities: [domain] })),
    ]);

    return {
      verification: verificationStatus(verification, domain),
      dkim: dkimStatus(dkim, domain),
    };
  } catch {
    throw new AppError('INTERNAL', 500, 'SES_STATUS_FAILED');
  }
}
