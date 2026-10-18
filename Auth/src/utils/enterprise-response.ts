import { AccessError, isRecord } from './organisation-access-schema.js';
const invalid = (): never => { throw new AccessError(502); };
export const record = (value: unknown): Record<string, unknown> => isRecord(value) ? value : invalid();
export const text = (value: unknown): string => typeof value === 'string' ? value : invalid();
