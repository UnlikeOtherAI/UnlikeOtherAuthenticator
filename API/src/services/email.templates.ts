import { EMAIL_TOKEN_TTL_MS } from '../config/constants.js';

type EmailTemplate = {
  subject: string;
  text: string;
  html: string;
};

/** Subset of config theme colors used to style emails. */
export type EmailTheme = {
  bg: string;
  surface: string;
  text: string;
  muted: string;
  primary: string;
  primaryText: string;
  border: string;
  buttonRadius: string;
  cardRadius: string;
  logoUrl?: string;
  logoAlt?: string;
  logoText?: string;
  logoFontSize?: string;
  logoFontWeight?: string;
  logoFontFamily?: string;
  logoColor?: string;
  fontImportUrl?: string;
};

const DEFAULT_THEME: EmailTheme = {
  bg: '#f6f7fb',
  surface: '#ffffff',
  text: '#111827',
  muted: '#6b7280',
  primary: '#111827',
  primaryText: '#ffffff',
  border: '#e8eaf0',
  buttonRadius: '10px',
  cardRadius: '12px',
};

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function tokenTtlMinutes(): number {
  return Math.max(1, Math.round(EMAIL_TOKEN_TTL_MS / (60 * 1000)));
}

function resolveTheme(theme?: Partial<EmailTheme>): EmailTheme {
  if (!theme) return DEFAULT_THEME;
  return { ...DEFAULT_THEME, ...theme };
}

function logoHtml(t: EmailTheme): string {
  if (t.logoUrl) {
    const alt = escapeHtml(t.logoAlt ?? '');
    const src = escapeHtml(t.logoUrl);
    return `<tr>
  <td align="center" style="padding:24px 24px 0 24px;">
    <img src="${src}" alt="${alt}" height="32" style="display:block;height:32px;width:auto;max-width:200px;" />
  </td>
</tr>`;
  }

  if (t.logoText) {
    const fontSize = t.logoFontSize ?? '24px';
    const fontWeight = t.logoFontWeight ?? '600';
    const fontFamily = t.logoFontFamily
      ? `${escapeHtml(t.logoFontFamily)},ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif`
      : 'ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif';
    const color = t.logoColor ?? t.text;
    return `<tr>
  <td align="center" style="padding:24px 24px 0 24px;font-family:${fontFamily};font-size:${escapeHtml(fontSize)};font-weight:${escapeHtml(fontWeight)};color:${escapeHtml(color)};">
    ${escapeHtml(t.logoText)}
  </td>
</tr>`;
  }

  return '';
}

function buildEmailHtml(params: {
  theme: EmailTheme;
  subject: string;
  heading: string;
  body: string;
  buttonLabel: string;
  buttonUrl: string;
  minutes: number;
}): string {
  const t = params.theme;
  const escapedLink = escapeHtml(params.buttonUrl);

  const fontLink = t.fontImportUrl
    ? `<link rel="stylesheet" href="${escapeHtml(t.fontImportUrl)}" />`
    : '';

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>${escapeHtml(params.subject)}</title>
    ${fontLink}
  </head>
  <body style="margin:0;padding:0;background-color:${t.bg};" bgcolor="${t.bg}">
    <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="background-color:${t.bg};padding:24px 12px;" bgcolor="${t.bg}">
      <tr>
        <td align="center" bgcolor="${t.bg}">
          <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="max-width:560px;background-color:${t.surface};border-radius:${t.cardRadius};overflow:hidden;border:1px solid ${t.border};" bgcolor="${t.surface}">
            ${logoHtml(t)}
            <tr>
              <td style="padding:24px 24px 8px 24px;font-family:ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:${t.text};">
                <h1 style="margin:0;font-size:20px;line-height:28px;color:${t.text};">${escapeHtml(params.heading)}</h1>
              </td>
            </tr>
            <tr>
              <td style="padding:0 24px 16px 24px;font-family:ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:${t.text};font-size:14px;line-height:22px;">
                ${escapeHtml(params.body)}
              </td>
            </tr>
            <tr>
              <td align="center" style="padding:0 24px 20px 24px;">
                <a href="${escapedLink}" style="display:inline-block;background-color:${t.primary};color:${t.primaryText};text-decoration:none;font-family:ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;font-size:14px;line-height:20px;padding:12px 16px;border-radius:${t.buttonRadius};">
                  ${escapeHtml(params.buttonLabel)}
                </a>
              </td>
            </tr>
            <tr>
              <td style="padding:0 24px 16px 24px;font-family:ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:${t.muted};font-size:12px;line-height:18px;">
                This link expires in ${params.minutes} minutes and can only be used once.
              </td>
            </tr>
            <tr>
              <td style="padding:0 24px 16px 24px;font-family:ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:${t.muted};font-size:12px;line-height:18px;">
                If the button does not work, copy and paste this URL into your browser:
                <div style="margin-top:8px;word-break:break-all;font-family:ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,monospace;color:${t.text};">${escapedLink}</div>
              </td>
            </tr>
            <tr>
              <td style="padding:0 24px 24px 24px;font-family:ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:${t.muted};font-size:12px;line-height:18px;">
                If you did not request this, you can ignore this email.
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`;
}

export function buildVerifyEmailSetPasswordTemplate(params: { link: string; theme?: Partial<EmailTheme> }): EmailTemplate {
  const minutes = tokenTtlMinutes();
  const theme = resolveTheme(params.theme);

  const subject = 'Your sign-in link';
  const text = [
    'Continue signing in',
    '',
    'Use this link to continue:',
    params.link,
    '',
    `This link expires in ${minutes} minutes and can only be used once.`,
    '',
    'If you did not request this, you can ignore this email.',
  ].join('\n');

  const html = buildEmailHtml({
    theme,
    subject,
    heading: 'Continue signing in',
    body: 'Click the button below to continue.',
    buttonLabel: 'Continue',
    buttonUrl: params.link,
    minutes,
  });

  return { subject, text, html };
}

export function buildVerifyEmailTemplate(params: { link: string; theme?: Partial<EmailTheme> }): EmailTemplate {
  const minutes = tokenTtlMinutes();
  const theme = resolveTheme(params.theme);

  const subject = 'Verify your email and sign in';
  const text = [
    'Verify your email and sign in',
    '',
    'Use this link to verify your email:',
    params.link,
    '',
    `This link expires in ${minutes} minutes and can only be used once.`,
    '',
    'If you did not request this, you can ignore this email.',
  ].join('\n');

  const html = buildEmailHtml({
    theme,
    subject,
    heading: 'Verify your email and sign in',
    body: 'Click the button below to verify your email.',
    buttonLabel: 'Verify email',
    buttonUrl: params.link,
    minutes,
  });

  return { subject, text, html };
}

export function buildLoginLinkTemplate(params: { link: string; theme?: Partial<EmailTheme> }): EmailTemplate {
  const minutes = tokenTtlMinutes();
  const theme = resolveTheme(params.theme);

  const subject = 'Your sign-in link';
  const text = [
    'Continue signing in',
    '',
    'Use this link to continue:',
    params.link,
    '',
    `This link expires in ${minutes} minutes and can only be used once.`,
    '',
    'If you did not request this, you can ignore this email.',
  ].join('\n');

  const html = buildEmailHtml({
    theme,
    subject,
    heading: 'Continue signing in',
    body: 'Click the button below to continue.',
    buttonLabel: 'Continue',
    buttonUrl: params.link,
    minutes,
  });

  return { subject, text, html };
}

export function buildAccountExistsTemplate(params: { link: string; theme?: Partial<EmailTheme> }): EmailTemplate {
  const minutes = tokenTtlMinutes();
  const theme = resolveTheme(params.theme);

  const subject = 'You already have an account';
  const text = [
    'You already have an account',
    '',
    'Someone tried to create an account with this email, but you already have one.',
    'If this was you, you can reset your password using the link below:',
    params.link,
    '',
    `This link expires in ${minutes} minutes and can only be used once.`,
    '',
    'If you did not request this, you can ignore this email.',
  ].join('\n');

  const html = buildEmailHtml({
    theme,
    subject,
    heading: 'You already have an account',
    body: 'Someone tried to create an account with this email, but you already have one. If this was you, you can reset your password using the button below.',
    buttonLabel: 'Reset password',
    buttonUrl: params.link,
    minutes,
  });

  return { subject, text, html };
}

export function buildPasswordResetTemplate(params: { link: string; theme?: Partial<EmailTheme> }): EmailTemplate {
  const minutes = tokenTtlMinutes();
  const theme = resolveTheme(params.theme);

  const subject = 'Reset your password';
  const text = [
    'Reset your password',
    '',
    'If you requested a password reset, use this link:',
    params.link,
    '',
    `This link expires in ${minutes} minutes and can only be used once.`,
    '',
    'If you did not request this, you can ignore this email.',
  ].join('\n');

  const html = buildEmailHtml({
    theme,
    subject,
    heading: 'Reset your password',
    body: 'If you requested a password reset, click the button below.',
    buttonLabel: 'Reset password',
    buttonUrl: params.link,
    minutes,
  });

  return { subject, text, html };
}

export function buildTwoFaResetTemplate(params: { link: string; theme?: Partial<EmailTheme> }): EmailTemplate {
  const minutes = tokenTtlMinutes();
  const theme = resolveTheme(params.theme);

  const subject = 'Reset two-factor authentication';
  const text = [
    'Reset two-factor authentication',
    '',
    'If you requested to reset two-factor authentication, use this link:',
    params.link,
    '',
    `This link expires in ${minutes} minutes and can only be used once.`,
    '',
    'If you did not request this, you can ignore this email.',
  ].join('\n');

  const html = buildEmailHtml({
    theme,
    subject,
    heading: 'Reset two-factor authentication',
    body: 'If you requested to reset two-factor authentication, click the button below.',
    buttonLabel: 'Reset two-factor authentication',
    buttonUrl: params.link,
    minutes,
  });

  return { subject, text, html };
}
