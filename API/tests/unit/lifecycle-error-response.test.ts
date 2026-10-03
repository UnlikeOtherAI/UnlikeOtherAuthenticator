import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppError } from '../../src/utils/errors.js';
import { buildPublicErrorBody } from '../../src/utils/error-response.js';

describe('lifecycle production error boundary', () => {
  beforeEach(() => vi.stubEnv('DEBUG_ENABLED', 'false'));
  afterEach(() => vi.unstubAllEnvs());

  it.each(['LIFECYCLE_TEMPLATE_CHANGED', 'DELETION_PREVIEW_CHANGED', 'DELETION_PRODUCTS_PENDING',
    'DELETION_ALREADY_RUNNING', 'LAST_ACTIVE_PLATFORM_ADMIN', 'ENTITY_DELETION_WORKFLOW_REQUIRED'])(
    'preserves actionable authenticated workflow code %s', (code) => {
      expect(buildPublicErrorBody({ statusCode: 409, error: new AppError('BAD_REQUEST', 409, code) }))
        .toEqual({ error: 'Request failed', code });
    },
  );
  it.each(['AUTHENTICATION_FAILED', 'ACCESS_DENIED', 'LIFECYCLE_STORE_REQUIRED'])(
    'does not expose identity state through %s', (code) => {
      expect(buildPublicErrorBody({ statusCode: 401, error: new AppError('UNAUTHORIZED', 401, code) }))
        .toEqual({ error: 'Request failed' });
    },
  );
});
