import { AppError } from '../utils/errors.js';

// Docs/brief.md ("Password Rules")
// - Minimum 8 characters
// - At least 1 uppercase, 1 lowercase, 1 number, 1 special character ("-" allowed)

const MIN_PASSWORD_LENGTH = 8;

const UPPERCASE_RE = /[A-Z]/;
const LOWERCASE_RE = /[a-z]/;
const NUMBER_RE = /[0-9]/;
// Any non-alphanumeric, non-whitespace counts as "special"; this explicitly includes '-'.
const SPECIAL_RE = /[^A-Za-z0-9\s]/;

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
