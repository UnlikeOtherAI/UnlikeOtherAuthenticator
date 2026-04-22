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
  'main{max-width:720px;margin:0 auto;padding:64px 20px;}',
  '.card{background:#111827;border:1px solid #334155;border-radius:18px;padding:32px;box-shadow:0 20px 45px rgba(15,23,42,.35);}',
  'h1{margin:0 0 12px;font-size:26px;line-height:1.2;}',
  'h2{margin:28px 0 8px;font-size:16px;line-height:1.3;color:#f8fafc;}',
  'p{color:#cbd5e1;line-height:1.6;}',
  '.chip{display:inline-block;margin-bottom:18px;padding:6px 12px;border-radius:999px;background:#1e293b;color:#f8fafc;font-size:12px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;}',
  '.chip.ok{background:#064e3b;}',
  '.chip.bad{background:#7f1d1d;}',
  '.kv{display:grid;grid-template-columns:minmax(120px,160px) 1fr;gap:8px 14px;margin:12px 0 0;}',
  '.kv dt{color:#94a3b8;font-weight:600;}',
  '.kv dd{margin:0;word-break:break-all;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:13px;}',
  '.warn{margin-top:24px;padding:12px 14px;border-radius:10px;background:rgba(234,179,8,.08);border:1px solid rgba(234,179,8,.3);color:#fde68a;font-size:13px;line-height:1.5;}',
  '.btn{display:inline-block;margin-top:20px;padding:12px 20px;border:none;background:#2563eb;color:#fff;border-radius:10px;font-size:14px;font-weight:600;cursor:pointer;}',
  '.btn:disabled{opacity:.6;cursor:default;}',
  'form{margin:0;}',
  'code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;background:#1e293b;padding:2px 6px;border-radius:4px;}',
  'a{color:#93c5fd;}',
].join('');

export type ClaimErrorKind = 'missing' | 'expired' | 'already_used';

function doc(title: string, body: string): string {
  return [
    '<!doctype html>',
    '<html lang="en">',
    '<head>',
    '<meta charset="UTF-8" />',
    '<meta name="viewport" content="width=device-width, initial-scale=1.0" />',
    '<meta name="robots" content="noindex,nofollow" />',
    `<title>${escapeHtml(title)}</title>`,
    `<style>${STYLE}</style>`,
    '</head><body><main><div class="card">',
    body,
    '</div></main></body></html>',
  ].join('');
}

/**
 * Friendly "link invalid" page shown when the claim token does not exist, has
 * expired, or has already been used. Intentionally identical copy for all three
 * error states — never leak whether a token *used* to exist.
 */
export function renderClaimInvalidHtml(_kind: ClaimErrorKind): string {
  return doc(
    'Claim link invalid',
    [
      '<span class="chip bad">INVALID</span>',
      '<h1>This claim link is no longer valid.</h1>',
      '<p>The link you used has expired, was already used, or was never issued.</p>',
      '<p>Contact the UnlikeOtherAuthenticator team that operates this service to request a new link.</p>',
    ].join(''),
  );
}

export type ConfirmPageParams = {
  confirmUrl: string;
};

/**
 * Pre-reveal confirmation page. Renders a POST form so that email clients' URL
 * scanners (which only issue GETs) cannot inadvertently consume the one-time
 * token before the partner sees it.
 */
export function renderClaimConfirmHtml(params: ConfirmPageParams): string {
  const action = escapeHtml(params.confirmUrl);
  return doc(
    'Reveal your client secret',
    [
      '<span class="chip ok">ONE-TIME</span>',
      '<h1>Ready to reveal your client secret</h1>',
      '<p>This page will display your <code>client_secret</code> and <code>client_hash</code> once. After you click reveal, the secret is not retrievable again — store it somewhere safe before leaving this page.</p>',
      `<form method="POST" action="${action}"><button type="submit" class="btn">Reveal client secret</button></form>`,
      '<p class="warn">If you did not expect this page, close this tab without submitting the form.</p>',
    ].join(''),
  );
}

export type RevealPageParams = {
  domain: string;
  clientHash: string;
  clientSecret: string;
  hashPrefix: string;
  llmUrl?: string;
};

/**
 * Post-consume reveal page. Shown only once. Displays the raw `client_secret`
 * and `client_hash` in monospace blocks alongside short setup guidance and a
 * link to the `/llm` integration guide.
 */
export function renderClaimRevealHtml(params: RevealPageParams): string {
  const llmLink = params.llmUrl
    ? `<p>Next: open <a href="${escapeHtml(params.llmUrl)}">/llm</a> for the complete integration guide.</p>`
    : '';

  return doc(
    'Your client secret',
    [
      '<span class="chip ok">REVEALED</span>',
      '<h1>Store these values now</h1>',
      '<p>This is the only time the client secret will be displayed. If you close this page without saving it, you must ask an administrator to rotate it.</p>',
      '<h2>Domain</h2>',
      '<dl class="kv">',
      `<dt>domain</dt><dd>${escapeHtml(params.domain)}</dd>`,
      `<dt>hash_prefix</dt><dd>${escapeHtml(params.hashPrefix)}</dd>`,
      '</dl>',
      '<h2>Credentials</h2>',
      '<dl class="kv">',
      `<dt>client_hash</dt><dd>${escapeHtml(params.clientHash)}</dd>`,
      `<dt>client_secret</dt><dd>${escapeHtml(params.clientSecret)}</dd>`,
      '</dl>',
      '<p class="warn">Treat <code>client_secret</code> like a password. It authenticates every request to UnlikeOtherAuthenticator from your backend.</p>',
      llmLink,
    ].join(''),
  );
}
