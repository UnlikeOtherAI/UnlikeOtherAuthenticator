import { getEnv } from '../config/env.js';
import { AppError } from '../utils/errors.js';

/** Refuse diagnostic proof creation and redemption before any route work. */
export async function requireAccessStatusEnabled(): Promise<void> {
  if (!getEnv().AUTH_ACCESS_STATUS_ENABLED) throw new AppError('NOT_FOUND', 404);
}
