import { renderInviteHtml } from './team-invite-page.service.js';

/** Isolated mailbox landing: no config fetch, third-party assets or OAuth redirect. */
export function renderRegistrationLinkPage(nonce: string): string {
  const html = renderInviteHtml({
    title: 'Confirm your email',
    body: 'Confirm to continue registration in the browser where you started. Only confirm if you requested this registration.',
    primaryAction: { id: 'verify', label: 'Verify email address' },
    statusId: 'result',
  });
  // A rejected link (expired, exhausted or malformed) can never succeed on retry, so only a
  // transport or server failure keeps the button; every final outcome removes it. Replaying
  // an already-used link stays idempotent: the API answers 200 and the page shows success.
  const script = `<script nonce="${nonce}">
(() => {
  let token = location.hash.slice(1);
  history.replaceState(null, '', location.pathname);
  const button = document.getElementById('verify');
  const actions = button.parentElement;
  const body = document.querySelector('h1').nextElementSibling;
  const result = document.getElementById('result');
  const finish = message => { token = ''; actions.remove(); body.style.marginBottom = '0'; result.textContent = message; };
  const retry = message => { button.disabled = false; result.textContent = message; };
  button.addEventListener('click', async () => {
    if (!token) { finish('This link cannot be used. Request a new email from the registration screen.'); return; }
    button.disabled = true;
    result.textContent = 'Verifying…';
    let response;
    try {
      response = await fetch('/auth/registration/link', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ token }), credentials: 'same-origin'
      });
    } catch {
      retry('We could not reach the server. Check your connection and try again.');
      return;
    }
    if (response.ok) {
      document.querySelector('h1').textContent = 'Email verified';
      body.textContent = 'Your email address is confirmed.';
      finish('Your original registration screen will continue automatically. This page has not signed you in.');
    } else if (response.status === 429 || response.status >= 500) {
      retry('We could not verify this link right now. Try again in a moment.');
    } else {
      finish('This link has expired or is no longer valid. Request a new email from the registration screen.');
    }
  });
})();
</script>`;
  return html.replace('</body>', `${script}</body>`);
}
