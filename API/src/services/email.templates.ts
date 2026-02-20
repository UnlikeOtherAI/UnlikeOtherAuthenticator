import { EMAIL_TOKEN_TTL_MS } from '../config/constants.js';

type EmailTemplate = {
  subject: string;
  text: string;
  html: string;
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
  // Keep the email copy stable and human-readable even if the TTL changes later.
  return Math.max(1, Math.round(EMAIL_TOKEN_TTL_MS / (60 * 1000)));
}

export function buildVerifyEmailSetPasswordTemplate(params: { link: string }): EmailTemplate {
  const minutes = tokenTtlMinutes();
  const escapedLink = escapeHtml(params.link);

  // Keep registration/login emails generic so copy doesn't imply account existence/state.
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

  // Inline CSS only; email clients strip external styles.
  const html = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>${escapeHtml(subject)}</title>
  </head>
  <body style="margin:0;padding:0;background:#f6f7fb;">
    <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="background:#f6f7fb;padding:24px 12px;">
      <tr>
        <td align="center">
          <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="max-width:560px;background:#ffffff;border-radius:12px;overflow:hidden;border:1px solid #e8eaf0;">
            <tr>
              <td style="padding:24px 24px 8px 24px;font-family:ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#111827;">
                <h1 style="margin:0;font-size:20px;line-height:28px;">Continue signing in</h1>
              </td>
            </tr>
            <tr>
              <td style="padding:0 24px 16px 24px;font-family:ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#374151;font-size:14px;line-height:22px;">
                Click the button below to continue.
              </td>
            </tr>
            <tr>
              <td align="center" style="padding:0 24px 20px 24px;">
                <a href="${escapedLink}" style="display:inline-block;background:#111827;color:#ffffff;text-decoration:none;font-family:ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;font-size:14px;line-height:20px;padding:12px 16px;border-radius:10px;">
                  Continue
                </a>
              </td>
            </tr>
            <tr>
              <td style="padding:0 24px 16px 24px;font-family:ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#6b7280;font-size:12px;line-height:18px;">
                This link expires in ${minutes} minutes and can only be used once.
              </td>
            </tr>
            <tr>
              <td style="padding:0 24px 16px 24px;font-family:ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#6b7280;font-size:12px;line-height:18px;">
                If the button does not work, copy and paste this URL into your browser:
                <div style="margin-top:8px;word-break:break-all;font-family:ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,monospace;color:#111827;">${escapedLink}</div>
              </td>
            </tr>
            <tr>
              <td style="padding:0 24px 24px 24px;font-family:ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#6b7280;font-size:12px;line-height:18px;">
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

export function buildVerifyEmailTemplate(params: { link: string }): EmailTemplate {
  const minutes = tokenTtlMinutes();
  const escapedLink = escapeHtml(params.link);

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

  const html = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>${escapeHtml(subject)}</title>
  </head>
  <body style="margin:0;padding:0;background:#f6f7fb;">
    <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="background:#f6f7fb;padding:24px 12px;">
      <tr>
        <td align="center">
          <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="max-width:560px;background:#ffffff;border-radius:12px;overflow:hidden;border:1px solid #e8eaf0;">
            <tr>
              <td style="padding:24px 24px 8px 24px;font-family:ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#111827;">
                <h1 style="margin:0;font-size:20px;line-height:28px;">Verify your email and sign in</h1>
              </td>
            </tr>
            <tr>
              <td style="padding:0 24px 16px 24px;font-family:ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#374151;font-size:14px;line-height:22px;">
                Click the button below to verify your email.
              </td>
            </tr>
            <tr>
              <td align="center" style="padding:0 24px 20px 24px;">
                <a href="${escapedLink}" style="display:inline-block;background:#111827;color:#ffffff;text-decoration:none;font-family:ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;font-size:14px;line-height:20px;padding:12px 16px;border-radius:10px;">
                  Verify email
                </a>
              </td>
            </tr>
            <tr>
              <td style="padding:0 24px 16px 24px;font-family:ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#6b7280;font-size:12px;line-height:18px;">
                This link expires in ${minutes} minutes and can only be used once.
              </td>
            </tr>
            <tr>
              <td style="padding:0 24px 16px 24px;font-family:ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#6b7280;font-size:12px;line-height:18px;">
                If the button does not work, copy and paste this URL into your browser:
                <div style="margin-top:8px;word-break:break-all;font-family:ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,monospace;color:#111827;">${escapedLink}</div>
              </td>
            </tr>
            <tr>
              <td style="padding:0 24px 24px 24px;font-family:ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#6b7280;font-size:12px;line-height:18px;">
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

export function buildLoginLinkTemplate(params: { link: string }): EmailTemplate {
  const minutes = tokenTtlMinutes();
  const escapedLink = escapeHtml(params.link);

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

  // Inline CSS only; email clients strip external styles.
  const html = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>${escapeHtml(subject)}</title>
  </head>
  <body style="margin:0;padding:0;background:#f6f7fb;">
    <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="background:#f6f7fb;padding:24px 12px;">
      <tr>
        <td align="center">
          <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="max-width:560px;background:#ffffff;border-radius:12px;overflow:hidden;border:1px solid #e8eaf0;">
            <tr>
              <td style="padding:24px 24px 8px 24px;font-family:ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#111827;">
                <h1 style="margin:0;font-size:20px;line-height:28px;">Continue signing in</h1>
              </td>
            </tr>
            <tr>
              <td style="padding:0 24px 16px 24px;font-family:ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#374151;font-size:14px;line-height:22px;">
                Click the button below to continue.
              </td>
            </tr>
            <tr>
              <td align="center" style="padding:0 24px 20px 24px;">
                <a href="${escapedLink}" style="display:inline-block;background:#111827;color:#ffffff;text-decoration:none;font-family:ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;font-size:14px;line-height:20px;padding:12px 16px;border-radius:10px;">
                  Continue
                </a>
              </td>
            </tr>
            <tr>
              <td style="padding:0 24px 16px 24px;font-family:ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#6b7280;font-size:12px;line-height:18px;">
                This link expires in ${minutes} minutes and can only be used once.
              </td>
            </tr>
            <tr>
              <td style="padding:0 24px 16px 24px;font-family:ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#6b7280;font-size:12px;line-height:18px;">
                If the button does not work, copy and paste this URL into your browser:
                <div style="margin-top:8px;word-break:break-all;font-family:ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,monospace;color:#111827;">${escapedLink}</div>
              </td>
            </tr>
            <tr>
              <td style="padding:0 24px 24px 24px;font-family:ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#6b7280;font-size:12px;line-height:18px;">
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

export function buildPasswordResetTemplate(params: { link: string }): EmailTemplate {
  const minutes = tokenTtlMinutes();
  const escapedLink = escapeHtml(params.link);

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

  // Inline CSS only; email clients strip external styles.
  const html = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>${escapeHtml(subject)}</title>
  </head>
  <body style="margin:0;padding:0;background:#f6f7fb;">
    <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="background:#f6f7fb;padding:24px 12px;">
      <tr>
        <td align="center">
          <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="max-width:560px;background:#ffffff;border-radius:12px;overflow:hidden;border:1px solid #e8eaf0;">
            <tr>
              <td style="padding:24px 24px 8px 24px;font-family:ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#111827;">
                <h1 style="margin:0;font-size:20px;line-height:28px;">Reset your password</h1>
              </td>
            </tr>
            <tr>
              <td style="padding:0 24px 16px 24px;font-family:ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#374151;font-size:14px;line-height:22px;">
                If you requested a password reset, click the button below.
              </td>
            </tr>
            <tr>
              <td align="center" style="padding:0 24px 20px 24px;">
                <a href="${escapedLink}" style="display:inline-block;background:#111827;color:#ffffff;text-decoration:none;font-family:ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;font-size:14px;line-height:20px;padding:12px 16px;border-radius:10px;">
                  Reset password
                </a>
              </td>
            </tr>
            <tr>
              <td style="padding:0 24px 16px 24px;font-family:ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#6b7280;font-size:12px;line-height:18px;">
                This link expires in ${minutes} minutes and can only be used once.
              </td>
            </tr>
            <tr>
              <td style="padding:0 24px 16px 24px;font-family:ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#6b7280;font-size:12px;line-height:18px;">
                If the button does not work, copy and paste this URL into your browser:
                <div style="margin-top:8px;word-break:break-all;font-family:ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,monospace;color:#111827;">${escapedLink}</div>
              </td>
            </tr>
            <tr>
              <td style="padding:0 24px 24px 24px;font-family:ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#6b7280;font-size:12px;line-height:18px;">
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

export function buildTwoFaResetTemplate(params: { link: string }): EmailTemplate {
  const minutes = tokenTtlMinutes();
  const escapedLink = escapeHtml(params.link);

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

  // Inline CSS only; email clients strip external styles.
  const html = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>${escapeHtml(subject)}</title>
  </head>
  <body style="margin:0;padding:0;background:#f6f7fb;">
    <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="background:#f6f7fb;padding:24px 12px;">
      <tr>
        <td align="center">
          <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="max-width:560px;background:#ffffff;border-radius:12px;overflow:hidden;border:1px solid #e8eaf0;">
            <tr>
              <td style="padding:24px 24px 8px 24px;font-family:ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#111827;">
                <h1 style="margin:0;font-size:20px;line-height:28px;">Reset two-factor authentication</h1>
              </td>
            </tr>
            <tr>
              <td style="padding:0 24px 16px 24px;font-family:ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#374151;font-size:14px;line-height:22px;">
                If you requested to reset two-factor authentication, click the button below.
              </td>
            </tr>
            <tr>
              <td align="center" style="padding:0 24px 20px 24px;">
                <a href="${escapedLink}" style="display:inline-block;background:#111827;color:#ffffff;text-decoration:none;font-family:ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;font-size:14px;line-height:20px;padding:12px 16px;border-radius:10px;">
                  Reset two-factor authentication
                </a>
              </td>
            </tr>
            <tr>
              <td style="padding:0 24px 16px 24px;font-family:ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#6b7280;font-size:12px;line-height:18px;">
                This link expires in ${minutes} minutes and can only be used once.
              </td>
            </tr>
            <tr>
              <td style="padding:0 24px 16px 24px;font-family:ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#6b7280;font-size:12px;line-height:18px;">
                If the button does not work, copy and paste this URL into your browser:
                <div style="margin-top:8px;word-break:break-all;font-family:ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,monospace;color:#111827;">${escapedLink}</div>
              </td>
            </tr>
            <tr>
              <td style="padding:0 24px 24px 24px;font-family:ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#6b7280;font-size:12px;line-height:18px;">
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
