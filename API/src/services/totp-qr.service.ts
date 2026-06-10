import { renderSVG } from '@unlikeotherai/qr-art';
import { fetch } from 'undici';

import { AppError } from '../utils/errors.js';

type LogoFetch = typeof fetch;

function assertOtpAuthUri(value: string): string {
  const trimmed = (value ?? '').trim();
  if (!trimmed || !trimmed.startsWith('otpauth://')) {
    throw new AppError('BAD_REQUEST', 400, 'INVALID_OTPAUTH_URI');
  }
  return trimmed;
}

async function inlineLogoUrl(logoUrl: string, fetchLogo: LogoFetch): Promise<string> {
  const trimmed = logoUrl.trim();
  if (!trimmed) return '';
  if (trimmed.startsWith('data:image/')) return trimmed;

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new AppError('BAD_REQUEST', 400, 'INVALID_LOGO_URL');
  }

  if (url.protocol !== 'https:') {
    throw new AppError('BAD_REQUEST', 400, 'INVALID_LOGO_URL');
  }

  const response = await fetchLogo(url);
  if (!response.ok) {
    throw new AppError('BAD_REQUEST', 400, 'LOGO_FETCH_FAILED');
  }

  const contentType = response.headers.get('content-type')?.split(';')[0]?.trim() || 'image/png';
  if (!contentType.startsWith('image/')) {
    throw new AppError('BAD_REQUEST', 400, 'LOGO_FETCH_FAILED');
  }

  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length === 0) {
    throw new AppError('BAD_REQUEST', 400, 'LOGO_FETCH_FAILED');
  }

  return `data:${contentType};base64,${bytes.toString('base64')}`;
}

export async function renderTotpQrSvg(
  params: { otpAuthUri: string; logoUrl?: string | null },
  deps?: { fetchLogo?: LogoFetch },
): Promise<string> {
  const otpAuthUri = assertOtpAuthUri(params.otpAuthUri);
  const logoSrc = params.logoUrl ? await inlineLogoUrl(params.logoUrl, deps?.fetchLogo ?? fetch) : '';

  const svg = renderSVG(otpAuthUri, {
    size: 384,
    shape: 'square',
    cornerRadius: 0.25,
    margin: 4,
    logo: logoSrc
      ? {
          src: logoSrc,
          overlay: true,
          sizeRatio: 0.22,
          padding: 10,
          borderRadius: 16,
        }
      : undefined,
  });

  return `data:image/svg+xml;base64,${Buffer.from(svg, 'utf8').toString('base64')}`;
}
