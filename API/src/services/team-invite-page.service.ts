/**
 * Server-rendered pages for the mail-bound team-invitation journey.
 *
 * These pages are reached straight from a mailbox, before any product session
 * exists, so they are deliberately self-contained HTML rather than the themed
 * auth popup: `/auth/email/team-invite` (the accept/decline landing) and
 * `/auth/email/link` (its terminal outcomes) must look like one continuous
 * flow to the invitee.
 */
import { isAppError } from '../utils/errors.js';

export function escapeInvitePageHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

export function renderInviteHtml(params: {
  title: string;
  body: string;
  acceptUrl?: string;
  declineUrl?: string;
}): string {
  const primaryButton = params.acceptUrl
    ? `<a href="${escapeInvitePageHtml(params.acceptUrl)}" style="display:inline-block;padding:12px 16px;border-radius:12px;background:#111827;color:#ffffff;text-decoration:none;font-weight:600;">Accept invitation</a>`
    : '';
  const declineButton = params.declineUrl
    ? `<a href="${escapeInvitePageHtml(params.declineUrl)}" style="display:inline-block;padding:12px 16px;border-radius:12px;border:1px solid #d1d5db;color:#111827;text-decoration:none;font-weight:600;">Decline invitation</a>`
    : '';

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>${escapeInvitePageHtml(params.title)}</title>
  </head>
  <body style="margin:0;background:#f3f4f6;font-family:ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#111827;">
    <div style="max-width:560px;margin:48px auto;padding:24px;">
      <div style="background:#ffffff;border:1px solid #e5e7eb;border-radius:16px;padding:32px;">
        <h1 style="margin:0 0 16px 0;font-size:28px;line-height:1.2;">${escapeInvitePageHtml(params.title)}</h1>
        <p style="margin:0 0 24px 0;font-size:16px;line-height:1.6;">${escapeInvitePageHtml(params.body)}</p>
        <div style="display:flex;gap:12px;flex-wrap:wrap;">${primaryButton}${declineButton}</div>
      </div>
    </div>
  </body>
</html>`;
}

/**
 * An expired invitation says so because the token holder needs to know that resending is the
 * remedy. Every other unusable state stays the same invalid result, so the page does not reveal
 * whether a token was revoked, consumed, malformed, or bound to different context.
 */
export function renderInviteUnavailableHtml(err: unknown): string {
  if (isAppError(err) && err.message === 'INVITE_EXPIRED') {
    return renderInviteHtml({
      title: 'Invitation expired',
      body: 'This invitation has expired. Ask the team to send you a new invitation.',
    });
  }
  return renderInviteHtml({
    title: 'Invitation invalid',
    body: 'This invitation is invalid. Ask the team to send you a new invitation.',
  });
}
