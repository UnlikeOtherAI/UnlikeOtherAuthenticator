import { escapeHtml, resolveTheme, type EmailTheme } from './email.templates.js';

/** This code approves a named product action; it must never look like a login email. */
export function buildActionVerificationTemplate(params: {
  code: string; domain: string; description: string; theme?: Partial<EmailTheme>;
}): { subject: string; text: string; html: string } {
  const theme = resolveTheme(params.theme);
  const subject = 'Confirm your requested change';
  const text = [subject, '', `${params.domain}: ${params.description}`, '',
    `Your verification code: ${params.code}`, '',
    'This code expires in 5 minutes and approves only this change.',
    'If you did not request this change, do not share or enter this code.',
  ].join('\n');
  const html = `<html><body style="background:${theme.bg};color:${theme.text};font-family:sans-serif;padding:24px">
    <h1>${subject}</h1><p>${escapeHtml(params.domain)}: ${escapeHtml(params.description)}</p>
    <p>Your verification code: <strong>${escapeHtml(params.code)}</strong></p>
    <p>This code expires in 5 minutes and approves only this change.</p>
    <p>If you did not request this change, do not share or enter this code.</p></body></html>`;
  return { subject, text, html };
}
