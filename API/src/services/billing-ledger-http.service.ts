import { createHash } from 'node:crypto';

import { AppError } from '../utils/errors.js';

const MAX_LEDGER_RESPONSE_BYTES = 2 * 1024 * 1024;

type LedgerResponseErrorCodes = {
  requestFailed: string;
  responseTooLarge: string;
  responseInvalid: string;
};

async function readBoundedBytes(response: Response, tooLargeCode: string): Promise<Uint8Array> {
  const declaredLength = response.headers.get('content-length');
  if (
    declaredLength &&
    /^\d+$/.test(declaredLength) &&
    BigInt(declaredLength) > BigInt(MAX_LEDGER_RESPONSE_BYTES)
  ) {
    throw new AppError('INTERNAL', 502, tooLargeCode);
  }
  if (!response.body) return new Uint8Array();

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const next = await reader.read();
    if (next.done) break;
    if (!next.value) continue;
    total += next.value.byteLength;
    if (total > MAX_LEDGER_RESPONSE_BYTES) {
      await reader.cancel();
      throw new AppError('INTERNAL', 502, tooLargeCode);
    }
    chunks.push(next.value);
  }

  const result = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

export async function fetchLedgerJsonResponse(
  params: {
    url: URL;
    headers: Record<string, string>;
    errors: LedgerResponseErrorCodes;
  },
  deps?: { fetch?: typeof fetch },
): Promise<{ value: unknown; sha256: string }> {
  let response: Response;
  try {
    response = await (deps?.fetch ?? fetch)(params.url, {
      method: 'GET',
      headers: params.headers,
      redirect: 'error',
      signal: AbortSignal.timeout(20_000),
    });
  } catch {
    throw new AppError('INTERNAL', 502, params.errors.requestFailed);
  }
  if (!response.ok || response.redirected) {
    throw new AppError('INTERNAL', 502, params.errors.requestFailed);
  }

  let bytes: Uint8Array;
  try {
    bytes = await readBoundedBytes(response, params.errors.responseTooLarge);
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError('INTERNAL', 502, params.errors.requestFailed);
  }

  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    return {
      value: JSON.parse(text) as unknown,
      sha256: createHash('sha256').update(bytes).digest('hex'),
    };
  } catch {
    throw new AppError('INTERNAL', 502, params.errors.responseInvalid);
  }
}
