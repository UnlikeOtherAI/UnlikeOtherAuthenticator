import { Response } from 'undici';
import { describe, expect, it, vi } from 'vitest';

import { renderTotpQrSvg } from '../totp-qr.service.js';
import { TOTP_QR_LOGO_MAX_BYTES } from '../../config/constants.js';

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

  it('passes through a data:image/ logo without fetching', async () => {
    const fetchLogo = vi.fn();
    const logo = 'data:image/png;base64,aW5saW5lLWxvZ28=';

    const dataUrl = await renderTotpQrSvg(
      { otpAuthUri, logoUrl: logo },
      { fetchLogo },
    );

    expect(fetchLogo).not.toHaveBeenCalled();
    expect(decodeSvg(dataUrl)).toContain(logo);
  });

  it('rejects a non-HTTPS logo URL with INVALID_LOGO_URL without fetching', async () => {
    const fetchLogo = vi.fn();

    await expect(
      renderTotpQrSvg(
        { otpAuthUri, logoUrl: 'http://app.example.com/logo.png' },
        { fetchLogo },
      ),
    ).rejects.toMatchObject({ statusCode: 400, message: 'INVALID_LOGO_URL' });
    expect(fetchLogo).not.toHaveBeenCalled();
  });

  // A config publisher who hosts the logo on a literal private address must never be fetched:
  // the QR embeds the fetched bytes, so this would be a full-read SSRF.
  it.each([
    'https://127.0.0.1/logo.png',
    'https://169.254.169.254/latest/meta-data',
    'https://10.0.0.8/logo.png',
    'https://192.168.1.1/logo.png',
    'https://[::1]/logo.png',
  ])('rejects a logo URL on blocked address %s without fetching', async (logoUrl) => {
    const fetchLogo = vi.fn();

    await expect(
      renderTotpQrSvg({ otpAuthUri, logoUrl }, { fetchLogo }),
    ).rejects.toMatchObject({ statusCode: 400, message: 'LOGO_FETCH_FAILED' });
    expect(fetchLogo).not.toHaveBeenCalled();
  });

  it('rejects a logo URL whose DNS resolves to a blocked address without fetching', async () => {
    const fetchLogo = vi.fn();

    await expect(
      renderTotpQrSvg(
        { otpAuthUri, logoUrl: 'https://localhost/logo.png' },
        { fetchLogo },
      ),
    ).rejects.toMatchObject({ statusCode: 400, message: 'LOGO_FETCH_FAILED' });
    expect(fetchLogo).not.toHaveBeenCalled();
  });

  it('refuses a logo whose declared content-length exceeds the cap', async () => {
    const fetchLogo = vi.fn(async () =>
      new Response(Buffer.alloc(TOTP_QR_LOGO_MAX_BYTES + 1, 0x41), {
        headers: {
          'content-type': 'image/png',
          'content-length': String(TOTP_QR_LOGO_MAX_BYTES + 1),
        },
      }),
    );

    await expect(
      renderTotpQrSvg(
        { otpAuthUri, logoUrl: 'https://app.example.com/logo.png' },
        { fetchLogo },
      ),
    ).rejects.toMatchObject({ statusCode: 400, message: 'LOGO_FETCH_FAILED' });
  });

  it('refuses a logo whose streamed body grows past the cap mid-flight', async () => {
    const fetchLogo = vi.fn(async () => {
      const chunk = Buffer.alloc(TOTP_QR_LOGO_MAX_BYTES, 0x41);
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(chunk);
          controller.enqueue(chunk);
          controller.close();
        },
      });
      return new Response(stream, { headers: { 'content-type': 'image/png' } });
    });

    await expect(
      renderTotpQrSvg(
        { otpAuthUri, logoUrl: 'https://app.example.com/logo.png' },
        { fetchLogo },
      ),
    ).rejects.toMatchObject({ statusCode: 400, message: 'LOGO_FETCH_FAILED' });
  });

  it('asks the server not to redirect, so a redirect cannot reach an unvalidated host', async () => {
    const fetchLogo = vi.fn(async (_url: string, init: Record<string, unknown>) => {
      expect(init.redirect).toBe('error');
      expect(init.dispatcher).toBeDefined();
      return new Response(Buffer.from('fake-logo'), {
        headers: { 'content-type': 'image/png' },
      });
    });

    await renderTotpQrSvg(
      { otpAuthUri, logoUrl: 'https://app.example.com/logo.png' },
      { fetchLogo },
    );

    expect(fetchLogo).toHaveBeenCalledOnce();
  });

  it('fails the logo fetch once the overall deadline passes', async () => {
    const fetchLogo = vi.fn(
      () => new Promise<Response>(() => {}),
    );

    await expect(
      renderTotpQrSvg(
        { otpAuthUri, logoUrl: 'https://app.example.com/logo.png' },
        { fetchLogo, deadlineMs: 25 },
      ),
    ).rejects.toMatchObject({ statusCode: 400, message: 'LOGO_FETCH_FAILED' });
  });
});
