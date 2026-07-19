import { createHmac } from 'node:crypto';

function base32Decode(value: string): Uint8Array {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  const cleaned = value.replace(/=+$/g, '').toUpperCase().replace(/[^A-Z2-7]/g, '');

  let bits = 0;
  let buffer = 0;
  const out: number[] = [];
  for (const ch of cleaned) {
    const index = alphabet.indexOf(ch);
    if (index === -1) continue;
    buffer = (buffer << 5) | index;
    bits += 5;
    while (bits >= 8) {
      bits -= 8;
      out.push((buffer >> bits) & 0xff);
    }
  }
  return Uint8Array.from(out);
}

export function computeTotp(params: {
  secret: string;
  nowMs: number;
  digits?: 6 | 8;
  period?: number;
}): string {
  const digits = params.digits ?? 6;
  const period = params.period ?? 30;
  const counter = BigInt(Math.floor(params.nowMs / 1000 / period));
  const counterBuffer = Buffer.alloc(8);
  counterBuffer.writeBigUInt64BE(counter);

  const mac = createHmac('sha1', Buffer.from(base32Decode(params.secret)))
    .update(counterBuffer)
    .digest();
  const offset = mac[mac.length - 1]! & 0x0f;
  const binaryCode =
    ((mac[offset]! & 0x7f) << 24) |
    ((mac[offset + 1]! & 0xff) << 16) |
    ((mac[offset + 2]! & 0xff) << 8) |
    (mac[offset + 3]! & 0xff);
  const modulus = digits === 8 ? 100_000_000 : 1_000_000;
  return String(binaryCode % modulus).padStart(digits, '0');
}
