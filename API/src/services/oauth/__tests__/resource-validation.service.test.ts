import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { isAppError } from '../../../utils/errors.js';
import { validateRequestedResource } from '../resource-validation.service.js';

// RFC 8707: a client-supplied `resource` becomes the token `aud`, so it must be bound
// to the configured allowlist (MCP_OAUTH_RESOURCES_SUPPORTED). An out-of-allowlist or
// otherwise unconstrained request must be rejected with invalid_target.
describe('validateRequestedResource', () => {
  const original = process.env.MCP_OAUTH_RESOURCES_SUPPORTED;

  beforeEach(() => {
    delete process.env.MCP_OAUTH_RESOURCES_SUPPORTED;
  });

  afterEach(() => {
    if (original === undefined) delete process.env.MCP_OAUTH_RESOURCES_SUPPORTED;
    else process.env.MCP_OAUTH_RESOURCES_SUPPORTED = original;
  });

  it('returns undefined when no resource is requested (aud falls back to issuer)', () => {
    expect(validateRequestedResource(undefined)).toBeUndefined();
    expect(validateRequestedResource('')).toBeUndefined();
    expect(validateRequestedResource('   ')).toBeUndefined();
  });

  it('accepts a requested resource that is in the allowlist', () => {
    process.env.MCP_OAUTH_RESOURCES_SUPPORTED =
      'https://api.example.com/mcp, https://other.example.com/mcp';
    expect(validateRequestedResource('https://api.example.com/mcp')).toBe(
      'https://api.example.com/mcp',
    );
    // Trailing/leading whitespace on the request is trimmed before matching.
    expect(validateRequestedResource('  https://other.example.com/mcp  ')).toBe(
      'https://other.example.com/mcp',
    );
  });

  it('rejects with INVALID_TARGET (400) when the allowlist is empty', () => {
    try {
      validateRequestedResource('https://api.example.com/mcp');
      throw new Error('expected validateRequestedResource to throw');
    } catch (err) {
      expect(isAppError(err)).toBe(true);
      if (isAppError(err)) {
        expect(err.statusCode).toBe(400);
        expect(err.message).toBe('INVALID_TARGET');
      }
    }
  });

  it('rejects with INVALID_TARGET (400) when the resource is not in the allowlist', () => {
    process.env.MCP_OAUTH_RESOURCES_SUPPORTED = 'https://api.example.com/mcp';
    try {
      validateRequestedResource('https://evil.example.com/mcp');
      throw new Error('expected validateRequestedResource to throw');
    } catch (err) {
      expect(isAppError(err)).toBe(true);
      if (isAppError(err)) {
        expect(err.statusCode).toBe(400);
        expect(err.message).toBe('INVALID_TARGET');
      }
    }
  });

  it('is case-sensitive (resource URIs are not lowercased)', () => {
    process.env.MCP_OAUTH_RESOURCES_SUPPORTED = 'https://api.example.com/MCP';
    expect(validateRequestedResource('https://api.example.com/MCP')).toBe(
      'https://api.example.com/MCP',
    );
    expect(() => validateRequestedResource('https://api.example.com/mcp')).toThrowError(
      'INVALID_TARGET',
    );
  });
});
