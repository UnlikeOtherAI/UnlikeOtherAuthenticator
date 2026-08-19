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
  // the QR embeds the fetched bytes, so this would be a full-read SSRF. The guard still refuses;
  // only the consequence changed — the QR degrades to no logo instead of failing enrolment.
  it.each([
    'https://127.0.0.1/logo.png',
    'https://169.254.169.254/latest/meta-data',
    'https://10.0.0.8/logo.png',
    'https://192.168.1.1/logo.png',
    'https://[::1]/logo.png',
  ])('renders without a logo when the guard blocks address %s', async (logoUrl) => {
    const fetchLogo = vi.fn();

    const dataUrl = await renderTotpQrSvg({ otpAuthUri, logoUrl }, { fetchLogo });
    const svg = decodeSvg(dataUrl);

    expect(dataUrl).toMatch(/^data:image\/svg\+xml;base64,/);
    expect(svg).toContain('<svg');
    expect(svg).not.toContain('<image href=');
    expect(fetchLogo).not.toHaveBeenCalled();
  });

  it('renders without a logo when the logo DNS resolves to a blocked address', async () => {
    const fetchLogo = vi.fn();

    const dataUrl = await renderTotpQrSvg(
      { otpAuthUri, logoUrl: 'https://localhost/logo.png' },
      { fetchLogo },
    );

    expect(decodeSvg(dataUrl)).toContain('<svg');
    expect(decodeSvg(dataUrl)).not.toContain('<image href=');
    expect(fetchLogo).not.toHaveBeenCalled();
  });

  it('renders without a logo when the declared content-length exceeds the cap', async () => {
    const fetchLogo = vi.fn(async () =>
      new Response(Buffer.alloc(TOTP_QR_LOGO_MAX_BYTES + 1, 0x41), {
        headers: {
          'content-type': 'image/png',
          'content-length': String(TOTP_QR_LOGO_MAX_BYTES + 1),
        },
      }),
    );

    const dataUrl = await renderTotpQrSvg(
      { otpAuthUri, logoUrl: 'https://app.example.com/logo.png' },
      { fetchLogo },
    );

    expect(decodeSvg(dataUrl)).toContain('<svg');
    expect(decodeSvg(dataUrl)).not.toContain('<image href=');
    expect(fetchLogo).toHaveBeenCalledOnce();
  });

  it('renders without a logo when the streamed body grows past the cap mid-flight', async () => {
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

    const dataUrl = await renderTotpQrSvg(
      { otpAuthUri, logoUrl: 'https://app.example.com/logo.png' },
      { fetchLogo },
    );

    expect(decodeSvg(dataUrl)).toContain('<svg');
    expect(decodeSvg(dataUrl)).not.toContain('<image href=');
    expect(fetchLogo).toHaveBeenCalledOnce();
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

  it('renders without a logo once the overall deadline passes', async () => {
    const fetchLogo = vi.fn(
      () => new Promise<Response>(() => {}),
    );

    const dataUrl = await renderTotpQrSvg(
      { otpAuthUri, logoUrl: 'https://app.example.com/logo.png' },
      { fetchLogo, deadlineMs: 25 },
    );

    expect(decodeSvg(dataUrl)).toContain('<svg');
    expect(decodeSvg(dataUrl)).not.toContain('<image href=');
    expect(fetchLogo).toHaveBeenCalledOnce();
  });

  it('renders without a logo when the server answers a non-ok status', async () => {
    const fetchLogo = vi.fn(async () =>
      new Response('not found', { status: 404, headers: { 'content-type': 'image/png' } }),
    );

    const dataUrl = await renderTotpQrSvg(
      { otpAuthUri, logoUrl: 'https://app.example.com/logo.png' },
      { fetchLogo },
    );

    expect(decodeSvg(dataUrl)).toContain('<svg');
    expect(decodeSvg(dataUrl)).not.toContain('<image href=');
    expect(fetchLogo).toHaveBeenCalledOnce();
  });

  it('renders without a logo when the response is not an image', async () => {
    const fetchLogo = vi.fn(async () =>
      new Response('<html></html>', { headers: { 'content-type': 'text/html' } }),
    );

    const dataUrl = await renderTotpQrSvg(
      { otpAuthUri, logoUrl: 'https://app.example.com/logo.png' },
      { fetchLogo },
    );

    expect(decodeSvg(dataUrl)).toContain('<svg');
    expect(decodeSvg(dataUrl)).not.toContain('<image href=');
    expect(fetchLogo).toHaveBeenCalledOnce();
  });

  it('renders without a logo when the fetch itself throws (e.g. refused redirect)', async () => {
    const fetchLogo = vi.fn(async () => {
      throw new TypeError('fetch failed');
    });

    const dataUrl = await renderTotpQrSvg(
      { otpAuthUri, logoUrl: 'https://app.example.com/logo.png' },
      { fetchLogo },
    );

    expect(decodeSvg(dataUrl)).toContain('<svg');
    expect(decodeSvg(dataUrl)).not.toContain('<image href=');
    expect(fetchLogo).toHaveBeenCalledOnce();
  });
});
