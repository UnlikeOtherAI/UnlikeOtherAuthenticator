import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import Stripe from 'stripe';
import { STRIPE_BILLING_API_VERSION } from '../../src/services/billing-stripe-client.service.js';

/** Authenticate each real provider request with the local CLI. Never export its credential. */
export function sandboxCliClient(expected: string) {
  assert.match(expected, /^acct_[A-Za-z0-9]+$/);
  const cli = process.env.STRIPE_CLI_PATH ?? 'stripe';
  function command(args: string[]) {
    try { return JSON.parse(execFileSync(cli, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 45000 })); }
    catch { throw new Error('Sandbox CLI request failed on ' + args.slice(0, 2).join(' ')); }
  }
  const httpClient = Stripe.createFetchHttpClient(async (input: string | URL | Request, init?: RequestInit) => {
    const req = new Request(input, init);
    const url = new URL(req.url);
    assert.equal(url.origin, 'https://api.stripe.com');
    assert.ok(url.pathname.startsWith('/v1/'));
    const who = command(['whoami', '--format', 'json']);
    assert.equal(who.account_id, expected); assert.equal(who.mode, 'test');
    const verb = req.method.toLowerCase();
    assert.ok(['get', 'post', 'delete'].includes(verb));
    const argv = [verb, url.pathname, '--stripe-version', STRIPE_BILLING_API_VERSION];
    if (verb === 'delete') argv.push('--confirm');
    const key = req.headers.get('idempotency-key');
    if (verb === 'post' && key) argv.push('--idempotency', key);
    const params = new URLSearchParams(await req.text());
    for (const [name, value] of [...url.searchParams, ...params]) argv.push('-d', name + '=' + value);
    const result = command(argv);
    if (result.error) throw new Error('Stripe sandbox refused ' + verb + ' ' + url.pathname +
      ' (' + (result.error.param ?? result.error.code ?? result.error.type) + ')');
    if ('livemode' in result) assert.equal(result.livemode, false);
    return Response.json(result);
  });
  // All traffic goes through the CLI transport above. The SDK requires a nonempty constructor value.
  return new Stripe('sandbox-cli-transport', { httpClient, apiVersion: STRIPE_BILLING_API_VERSION, maxNetworkRetries: 0 });
}

