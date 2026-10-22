import { createServer, request, type Server } from 'node:https';
import { createHash, randomBytes } from 'node:crypto';
import { SignJWT, generateKeyPair, exportJWK, type JWTPayload } from 'jose';

/** Real local HTTPS provider; only the test transport trusts its private certificate. */
export async function localEnterpriseOidcProvider(tls: { private_key: string; certificate: string }, redirectUri: string) {
  const signing = await generateKeyPair('RS256'); const foreign = await generateKeyPair('RS256');
  const ec = await generateKeyPair('ES256');
  const rsa = { ...await exportJWK(signing.publicKey), kid: 'signing-key', use: 'sig', alg: 'RS256' };
  const unrelated = { ...await exportJWK(ec.publicKey), kid: 'unrelated-ec', use: 'sig', alg: 'ES256' };
  const state = { claims: {} as JWTPayload, signingKid: 'signing-key', wrongSignature: false, duplicateKid: false };
  const codes = new Map<string, { nonce: string; challenge: string; redirect: string; claims: JWTPayload; kid: string; wrong: boolean }>();
  const clientId = 'fixture-client'; const secret = 'fixture-secret'; const tenant = 'exact-tenant';
  let issuer = '';
  const server: Server = createServer({ key: tls.private_key, cert: tls.certificate }, (req, res) => {
    const run = async () => {
      const url = new URL(req.url ?? '/', issuer);
      const json = (status: number, value: unknown) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(value)); };
      if (url.pathname === '/.well-known/openid-configuration') return json(200, { issuer,
        authorization_endpoint: `${issuer}/authorize`, token_endpoint: `${issuer}/token`, jwks_uri: `${issuer}/jwks` });
      if (url.pathname === '/jwks') return json(200, { keys: state.duplicateKid ? [rsa, rsa] : [unrelated,
        { ...rsa, kid: 'encryption-key', use: 'enc' }, rsa] });
      if (url.pathname === '/authorize') {
        if (url.searchParams.get('client_id') !== clientId || url.searchParams.get('response_type') !== 'code' ||
          url.searchParams.get('code_challenge_method') !== 'S256' || !url.searchParams.get('nonce') || !url.searchParams.get('state')) return json(400, { error: 'invalid_request' });
        const redirect = url.searchParams.get('redirect_uri') ?? '';
        if (redirect !== redirectUri) return json(400, { error: 'invalid_request' });
        const code = randomBytes(32).toString('base64url');
        codes.set(code, { nonce: url.searchParams.get('nonce') ?? '', challenge: url.searchParams.get('code_challenge') ?? '',
          redirect, claims: { ...state.claims }, kid: state.signingKid, wrong: state.wrongSignature });
        const target = new URL(redirect); target.searchParams.set('code', code); target.searchParams.set('state', url.searchParams.get('state') ?? '');
        target.searchParams.set('iss', issuer); res.writeHead(302, { location: target.toString() }); res.end(); return;
      }
      if (url.pathname === '/token' && req.method === 'POST') {
        let raw = ''; for await (const chunk of req) { raw += String(chunk); if (raw.length > 8192) return json(400, { error: 'invalid_request' }); }
        const body = new URLSearchParams(raw); const code = body.get('code') ?? ''; const stored = codes.get(code); codes.delete(code);
        const basic = req.headers.authorization?.startsWith('Basic ') ? Buffer.from(req.headers.authorization.slice(6), 'base64').toString('utf8').split(':') : null;
        if (!stored || (basic ? decodeURIComponent(basic[0]) !== clientId || decodeURIComponent(basic[1]) !== secret :
          body.get('client_id') !== clientId || body.get('client_secret') !== secret) || body.get('grant_type') !== 'authorization_code' ||
          body.get('redirect_uri') !== stored.redirect || createHash('sha256').update(body.get('code_verifier') ?? '').digest('base64url') !== stored.challenge) {
          return json(400, { error: 'invalid_grant' });
        }
        const now = Math.floor(Date.now() / 1000);
        const token = await new SignJWT({ iss: issuer, aud: clientId, sub: 'stable-subject', tenant, nonce: stored.nonce,
          iat: now, exp: now + 3600, email: 'person@corporate.example.com', email_verified: true, ...stored.claims })
          .setProtectedHeader({ alg: 'RS256', kid: stored.kid }).sign(stored.wrong ? foreign.privateKey : signing.privateKey);
        return json(200, { id_token: token, access_token: 'provider-access-token' });
      }
      return json(404, { error: 'not_found' });
    };
    void run().catch(() => { if (!res.headersSent) res.writeHead(500); res.end(); });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('Fixture bind failed');
  issuer = `https://127.0.0.1:${address.port}`;
  const wire = async (url: string, options: { method?: string; headers?: Record<string, string>; body?: string } = {}) => {
    if (new URL(url).origin !== issuer) throw new Error('Fixture transport destination refused');
    return new Promise<{ status: number; headers: Record<string, string | string[] | undefined>; body: string }>((resolve, reject) => {
      const outgoing = request(url, { rejectUnauthorized: false, method: options.method ?? 'GET', headers: options.headers }, (incoming) => {
        let body = ''; incoming.on('data', (chunk) => { body += String(chunk); if (body.length > 65536) outgoing.destroy(new Error('Fixture response limit')); });
        incoming.on('end', () => resolve({ status: incoming.statusCode ?? 500, headers: incoming.headers, body }));
      });
      outgoing.setTimeout(5000, () => outgoing.destroy(new Error('Fixture timeout'))); outgoing.on('error', reject);
      if (options.body) outgoing.write(options.body); outgoing.end();
    });
  };
  return { issuer, clientId, secret, state, wire, close: () => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())) };
}
