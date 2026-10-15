import { request, type IncomingHttpHeaders } from 'node:http';

export async function socketRequest(base: string, path: string, options: {
  method?: string; headers?: Record<string, string>; json?: unknown; body?: Buffer;
} = {}): Promise<{ status: number; headers: IncomingHttpHeaders; body: Buffer; json: <T = unknown>() => T }> {
  const body = options.body ?? (options.json === undefined ? undefined : Buffer.from(JSON.stringify(options.json)));
  return new Promise((resolve, reject) => {
    const req = request(new URL(path, base), { method: options.method ?? 'GET', agent: false,
      headers: { ...(options.json === undefined ? {} : { 'content-type': 'application/json' }),
        ...options.headers, ...(body ? { 'content-length': String(body.length) } : {}) } }, response => {
      const chunks: Buffer[] = [];
      response.on('data', chunk => chunks.push(Buffer.from(chunk)));
      response.on('error', reject);
      response.on('aborted', () => reject(new Error('Audit HTTP response aborted')));
      response.on('end', () => {
        const bytes = Buffer.concat(chunks);
        resolve({ status: response.statusCode ?? 0, headers: response.headers, body: bytes,
          json: <T>() => JSON.parse(bytes.toString('utf8')) as T });
      });
    });
    req.setTimeout(15_000, () => req.destroy(new Error('Audit HTTP request timed out')));
    req.on('error', reject);
    req.end(body);
  });
}
