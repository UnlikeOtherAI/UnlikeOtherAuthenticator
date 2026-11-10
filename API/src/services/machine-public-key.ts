import { MachinePublicKey } from './machine-contract.js';
import { AppError } from '../utils/errors.js';

// Small-order y-coordinate encodings, both sign bits. Numeric vectors from
// libsodium ge25519_has_small_order at 45b09a607d596e40adbff9ab812e47d85175c053:
// https://github.com/jedisct1/libsodium/blob/45b09a607d596e40adbff9ab812e47d85175c053/src/libsodium/crypto_core/ed25519/ref10/ed25519_ref10.c#L1022
// OpenSSL still owns signature verification. A torsion-only key cannot prove
// possession of a protected Ed25519 private key and is never registrable here.
const smallOrderY = new Set([
  '00'.repeat(32), '01' + '00'.repeat(31),
  '26e8958fc2b227b045c3f489f2ef98f0d5dfac05d3c63339b13802886d53fc05',
  'c7176a703d4dd84fba3c0b760d10670f2a2053fa2c39ccc64ec7fd7792ac037a',
  'ec' + 'ff'.repeat(30) + '7f',
]);
const fieldPrime = Buffer.from('7f' + 'ff'.repeat(30) + 'ed', 'hex');
export function checkedMachinePublicKey(value: unknown) {
  const key = MachinePublicKey.parse(value);
  const point = Buffer.from(key.x, 'base64url');
  if (point.length !== 32 || point.toString('base64url') !== key.x) reject();
  const y = Buffer.from(point); y[31] &= 0x7f;
  if (smallOrderY.has(y.toString('hex')) || Buffer.compare(Buffer.from(y).reverse(), fieldPrime) >= 0) reject();
  return key;
}
function reject(): never { throw new AppError('UNAUTHORIZED', 401, 'MACHINE_PROOF_INVALID'); }
