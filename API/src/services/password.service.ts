import { AppError } from '../utils/errors.js';
import argon2 from 'argon2';

// Docs/brief.md ("Password Rules")
// - Minimum 8 characters
// - At least 1 uppercase, 1 lowercase, 1 number, 1 special character ("-" allowed)

const MIN_PASSWORD_LENGTH = 8;

const UPPERCASE_RE = /[A-Z]/;
const LOWERCASE_RE = /[a-z]/;
const NUMBER_RE = /[0-9]/;
// Any non-alphanumeric, non-whitespace counts as "special"; this explicitly includes '-'.
const SPECIAL_RE = /[^A-Za-z0-9\s]/;

// Password hashing (Docs/brief.md "Password Storage"): standard secure hashing, no plaintext stored.
//
// Use Argon2id (modern, memory-hard) with parameters sized to be reasonably strong without
// being so slow it harms UX or tests. The output includes salt + parameters.
const ARGON2_OPTIONS: argon2.Options & { type: number } = {
  type: argon2.argon2id,
  timeCost: 3,
  // argon2 expects memoryCost in KiB.
  memoryCost: 2 ** 15, // 32 MiB
  parallelism: 1,
  hashLength: 32,
};

// Used to mitigate timing-based email enumeration during login. When a user doesn't exist
// (or has no password hash), we still run an Argon2 verify against this dummy hash so the
// request does not short-circuit cheaply.
const DUMMY_ARGON2ID_HASH =
  '$argon2id$v=19$m=32768,t=3,p=1$onb6T27gs47vxfVunB08uQ$hadGiwenm9HEKxSvGEbaklz91en+kFM92aGWwSFMYGY';

export function isPasswordValid(password: string): boolean {
  if (typeof password !== 'string') return false;
  if (password.length < MIN_PASSWORD_LENGTH) return false;

  return (
    UPPERCASE_RE.test(password) &&
    LOWERCASE_RE.test(password) &&
    NUMBER_RE.test(password) &&
    SPECIAL_RE.test(password)
  );
}

export function assertPasswordValid(password: string): void {
  if (!isPasswordValid(password)) {
    // User-facing error will be generic (see global error handler); message is for internal logs only.
    throw new AppError('BAD_REQUEST', 400, 'PASSWORD_POLICY_VIOLATION');
  }
}

export async function hashPassword(password: string): Promise<string> {
  assertPasswordValid(password);

  try {
    return await argon2.hash(password, ARGON2_OPTIONS);
  } catch {
    // Never leak hashing failures. Treat as internal.
    throw new AppError('INTERNAL', 500, 'PASSWORD_HASH_FAILED');
  }
}

export async function verifyPassword(
  password: string,
  passwordHash: string | null | undefined,
): Promise<boolean> {
  if (typeof password !== 'string') return false;

  const hashToVerify =
    typeof passwordHash === 'string' && passwordHash ? passwordHash : DUMMY_ARGON2ID_HASH;

  try {
    return await argon2.verify(hashToVerify, password);
  } catch {
    // Corrupt/unknown hash formats should just fail closed, but also avoid a fast throw path.
    try {
      await argon2.verify(DUMMY_ARGON2ID_HASH, password);
    } catch {
      // Ignore.
    }
    return false;
  }
}
