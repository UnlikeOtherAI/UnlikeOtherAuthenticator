import { fetch as fetchPinned } from 'undici';
import { closeSsrfAgent, createPinnedAgent, parseHttpsUrl, resolvePublicDestinations } from '../utils/ssrf.js';
import { AppError } from '../utils/errors.js';

/** No automatic redirects, including credential-bearing POSTs. Every destination is operator-pinned. */
export async function enterpriseFetch(url: string, trustedOrigins: readonly string[], options: {
  method?: 'GET' | 'POST'; headers?: Record<string, string>; body?: string; limit?: number;
} = {}): Promise<string> {
  const target = parseHttpsUrl(url);
  if (target.username || target.password || target.hash ||
    !trustedOrigins.some((origin) => new URL(origin).origin === target.origin)) {
    throw new AppError('BAD_REQUEST', 400, 'SSO_ENDPOINT_NOT_TRUSTED');
  }
  const addresses = await resolvePublicDestinations(target);
  const agent = createPinnedAgent(target, addresses[0]);
  const abort = new AbortController();
  const timeout = setTimeout(() => abort.abort(), 5000);
  try {
    const response = await fetchPinned(target, { dispatcher: agent, redirect: 'manual',
      method: options.method ?? 'GET', headers: { accept: 'application/json', ...options.headers },
      body: options.body, signal: abort.signal });
    if (!response.ok || !response.body || response.headers.get('content-encoding')) {
      await response.body?.cancel();
      throw new AppError('BAD_REQUEST', 400, 'SSO_PROVIDER_RESPONSE_INVALID');
    }
    const limit = options.limit ?? 65536;
    let size = 0;
    const chunks: Buffer[] = [];
    for await (const chunk of response.body) {
      size += chunk.length;
      if (size > limit) { await response.body.cancel(); throw new AppError('BAD_REQUEST', 400, 'SSO_RESPONSE_TOO_LARGE'); }
      chunks.push(Buffer.from(chunk));
    }
    return Buffer.concat(chunks).toString('utf8');
  } finally { clearTimeout(timeout); await closeSsrfAgent(agent); }
}
