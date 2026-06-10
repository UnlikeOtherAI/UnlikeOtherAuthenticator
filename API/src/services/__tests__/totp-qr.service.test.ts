import { Response } from 'undici';
import { describe, expect, it, vi } from 'vitest';

import { renderTotpQrSvg } from '../totp-qr.service.js';

function decodeSvg(dataUrl: string): string {
  const base64 = dataUrl.replace(/^data:image\/svg\+xml;base64,/, '');
  return Buffer.from(base64, 'base64').toString('utf8');
}

describe('renderTotpQrSvg', () => {
  const otpAuthUri =
    'otpauth://totp/Example:alice%40example.com?secret=ABCDEF234567&issuer=Example';

  it('renders a self-contained SVG data URL without a logo', async () => {
    const dataUrl = await renderTotpQrSvg({ otpAuthUri });
    const svg = decodeSvg(dataUrl);

    expect(dataUrl).toMatch(/^data:image\/svg\+xml;base64,/);
    expect(svg).toContain('<svg');
    expect(svg).not.toContain('<image href=');
  });

  it('fetches and embeds a remote logo as a data URI', async () => {
    const fetchLogo = vi.fn(async () =>
      new Response(Buffer.from('fake-logo'), {
        headers: { 'content-type': 'image/png' },
      }),
    );

    const dataUrl = await renderTotpQrSvg(
      {
        otpAuthUri,
        logoUrl: 'https://app.example.com/logo.png',
      },
      { fetchLogo },
    );
    const svg = decodeSvg(dataUrl);

    expect(fetchLogo).toHaveBeenCalledOnce();
    expect(svg).toContain('data:image/png;base64,ZmFrZS1sb2dv');
    expect(svg).not.toContain('https://app.example.com/logo.png');
  });
});
