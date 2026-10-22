import { renderInviteHtml } from './team-invite-page.service.js';

/** Isolated mailbox landing: no config fetch, third-party assets or OAuth redirect. */
export function renderRegistrationLinkPage(nonce: string): string {
  const html = renderInviteHtml({
    title: 'Confirm your email',
    body: 'Verify your email address, then return to the registration screen where you started.',
    primaryAction: { id: 'verify', label: 'Verify email address' },
  });
  const result = '<p id="result" role="status" aria-live="polite"></p>';
  const script = `<script nonce="${nonce}">
(() => {
  let token = location.hash.slice(1);
  history.replaceState(null, '', location.pathname);
  const button = document.getElementById('verify');
  const result = document.getElementById('result');
  button.addEventListener('click', async () => {
    if (!token) { result.textContent = 'This link cannot be used. Request a new email from the registration screen.'; return; }
    button.disabled = true;
    result.textContent = 'Verifying…';
    try {
      const response = await fetch('/auth/registration/link', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ token }), credentials: 'same-origin'
      });
      if (!response.ok) throw new Error('verification failed');
      token = '';
      document.querySelector('h1').textContent = 'Email verified';
      result.textContent = 'Your email address is confirmed. Return to the registration screen to continue. This device has not been signed in.';
      button.hidden = true;
    } catch {
      result.textContent = 'We could not verify this link. Try again, or request a new email from the registration screen.';
      button.disabled = false;
    }
  });
})();
</script>`;
  return html.replace('</button>', `</button>${result}`)
    .replace('</body>', `${script}</body>`);
}
