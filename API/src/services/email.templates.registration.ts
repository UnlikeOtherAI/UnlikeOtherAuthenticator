import { escapeHtml, resolveTheme, type EmailTheme } from './email.templates.js';

export function buildRegistrationVerificationTemplate(params: {
  link: string; code: string; theme?: Partial<EmailTheme>;
}): { subject: string; text: string; html: string } {
  const t = resolveTheme(params.theme);
  const subject = 'Verify your email address';
  const text = [
    'Confirm your email', '',
    'Open this link on any device to confirm your email address:', params.link, '',
    `Or enter this code on the registration screen that requested it: ${params.code}`, '',
    'The link and code expire in 15 minutes. The link can only be used once.',
    'Opening the link on another device does not sign that device in.',
    'If you did not request this, ignore this email.',
  ].join('\n');
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${subject}</title></head>
<body style="margin:0;padding:24px 12px;background:${t.bg};color:${t.text};font-family:Arial,sans-serif;">
<table role="presentation" width="100%"><tr><td align="center">
<table role="presentation" width="100%" style="max-width:560px;background:${t.surface};border:1px solid ${t.border};border-radius:${t.cardRadius};"><tr><td style="padding:32px 24px;">
<h1 style="margin:0 0 16px;font-size:24px;">Confirm your email</h1>
<p style="line-height:1.6;">Click the button on any device, or enter the code on the registration screen that requested it.</p>
<p style="text-align:center;margin:28px 0;"><a href="${escapeHtml(params.link)}" style="display:inline-block;padding:14px 24px;background:${t.primary};color:${t.primaryText};border-radius:${t.buttonRadius};font-weight:bold;text-decoration:none;">Verify email address</a></p>
<p style="text-align:center;">Or enter this verification code:</p>
<p style="text-align:center;font-family:monospace;font-size:32px;font-weight:700;letter-spacing:8px;margin:20px 0;">${escapeHtml(params.code)}</p>
<p style="font-size:14px;line-height:1.6;color:${t.muted};">The link and code expire in 15 minutes. The link can only be used once. Opening it on another device does not sign that device in.</p>
<p style="font-size:14px;color:${t.muted};">If you did not request this, ignore this email.</p>
</td></tr></table></td></tr></table></body></html>`;
  return { subject, text, html };
}
