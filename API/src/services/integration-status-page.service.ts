function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const STYLE = [
  'body{margin:0;font-family:ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:#0f172a;color:#e2e8f0;}',
  'main{max-width:640px;margin:0 auto;padding:64px 20px;}',
  '.card{background:#111827;border:1px solid #334155;border-radius:18px;padding:32px;box-shadow:0 20px 45px rgba(15,23,42,.35);}',
  'h1{margin:0 0 12px;font-size:26px;line-height:1.2;}',
  'p{color:#cbd5e1;line-height:1.6;}',
  '.chip{display:inline-block;margin-bottom:18px;padding:6px 12px;border-radius:999px;background:#1e293b;color:#f8fafc;font-size:12px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;}',
  '.chip.declined{background:#7f1d1d;}',
  'dl{display:grid;grid-template-columns:minmax(120px,140px) 1fr;gap:8px 14px;margin:18px 0 0;}',
  'dt{color:#94a3b8;font-weight:600;}',
  'dd{margin:0;word-break:break-word;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:13px;}',
  '.note{margin-top:24px;color:#94a3b8;font-size:13px;}',
].join('');

export type IntegrationStatusPageKind = 'pending' | 'declined';

export type IntegrationStatusPageParams = {
  kind: IntegrationStatusPageKind;
  domain: string;
};

/**
 * Renders a friendly public-facing page for the two auto-onboarding terminal states:
 *
 * - "pending"  — the request was captured; a superuser has been notified; the partner
 *                will receive a claim email at the contact address once approved.
 * - "declined" — a prior request for this domain was declined; no new request will be
 *                created until a superuser deletes the existing row.
 *
 * No internal diagnostics are leaked (including the contact email).
 */
export function renderIntegrationStatusHtml(params: IntegrationStatusPageParams): string {
  const isDeclined = params.kind === 'declined';
  const title = isDeclined ? 'Integration declined' : 'Integration pending review';
  const chip = isDeclined ? 'DECLINED' : 'PENDING';
  const chipClass = isDeclined ? 'chip declined' : 'chip';
  const body = isDeclined
    ? [
        '<p>A previous request to onboard this domain was declined.</p>',
        '<p>If you believe this is a mistake, contact the UnlikeOtherAuthenticator team that operates this service.</p>',
      ]
    : [
        '<p>Thanks — your integration request has been captured.</p>',
        '<p>An UnlikeOtherAuthenticator superuser has been notified. Once they approve this integration, the system admin will receive an email with a one-time link to copy your client secret.</p>',
      ];

  return [
    '<!doctype html>',
    '<html lang="en">',
    '<head>',
    '<meta charset="UTF-8" />',
    '<meta name="viewport" content="width=device-width, initial-scale=1.0" />',
    `<title>${escapeHtml(title)}</title>`,
    `<style>${STYLE}</style>`,
    '</head><body><main><div class="card">',
    `<span class="${chipClass}">${escapeHtml(chip)}</span>`,
    `<h1>${escapeHtml(title)}</h1>`,
    ...body,
    '<dl>',
    `<dt>Domain</dt><dd>${escapeHtml(params.domain)}</dd>`,
    '</dl>',
    isDeclined
      ? '<p class="note">Further auto-discovery attempts for this domain are blocked until support removes the declined record.</p>'
      : '<p class="note">You can safely close this window — no further action is required on this browser.</p>',
    '</div></main></body></html>',
  ].join('');
}
