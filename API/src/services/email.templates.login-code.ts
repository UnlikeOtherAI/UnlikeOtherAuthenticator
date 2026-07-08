import { LOGIN_CODE_TTL_MS } from '../config/constants.js';
import { escapeHtml, logoHtml, resolveTheme, type EmailTheme } from './email.templates.js';

type EmailTemplate = {
  subject: string;
  text: string;
  html: string;
};

function codeTtlMinutes(): number {
  return Math.max(1, Math.round(LOGIN_CODE_TTL_MS / (60 * 1000)));
}

/**
 * Phase 3b (design §4.3, §11.6): the sign-in code email. Deliberately generic — it never reveals
 * anything about account state beyond "here is your sign-in code", matching the no-enumeration
 * requirement on /auth/start (brief §22.11).
 */
export function buildLoginCodeTemplate(params: {
  code: string;
  theme?: Partial<EmailTheme>;
}): EmailTemplate {
  const theme = resolveTheme(params.theme);
  const minutes = codeTtlMinutes();

  const subject = 'Your sign-in code';
  const text = [
    'Your sign-in code',
    '',
    `Enter this code to sign in: ${params.code}`,
    '',
    `This code expires in ${minutes} minutes and can only be used once.`,
    '',
    'If you did not request this, you can ignore this email.',
  ].join('\n');

  const t = theme;
  const fontLink = t.fontImportUrl
    ? `<link rel="stylesheet" href="${escapeHtml(t.fontImportUrl)}" />`
    : '';

  const html = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>${escapeHtml(subject)}</title>
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
                <h1 style="margin:0;font-size:20px;line-height:28px;color:${t.text};">Your sign-in code</h1>
              </td>
            </tr>
            <tr>
              <td style="padding:0 24px 16px 24px;font-family:ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:${t.text};font-size:14px;line-height:22px;">
                Enter this code to sign in:
              </td>
            </tr>
            <tr>
              <td align="center" style="padding:0 24px 20px 24px;">
                <div style="display:inline-block;background-color:${t.bg};color:${t.text};font-family:ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,monospace;font-size:28px;font-weight:700;letter-spacing:6px;padding:12px 20px;border-radius:${t.buttonRadius};border:1px solid ${t.border};">
                  ${escapeHtml(params.code)}
                </div>
              </td>
            </tr>
            <tr>
              <td style="padding:0 24px 16px 24px;font-family:ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:${t.muted};font-size:12px;line-height:18px;">
                This code expires in ${minutes} minutes and can only be used once.
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

  return { subject, text, html };
}
