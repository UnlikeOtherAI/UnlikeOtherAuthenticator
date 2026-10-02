import { describe, expect, it } from 'vitest';
import { clientService, clientServiceContainsUrl } from '../../src/utils/client-service.js';
import {
  assertConfigDomainMatchesConfigUrl,
  validateConfigFields,
} from '../../src/services/config.service.js';
import { baseClientConfigPayload } from '../helpers/test-config.js';

const identity = 'therockbottom.co.uk/rafikimedia';
describe('independent subfolder service identity', () => {
  it('retains hostname clients and accepts canonical service paths', () => {
    expect(clientService('Example.COM.')).toEqual({ hostname: 'example.com', path: '' });
    expect(clientService(identity)).toEqual({
      hostname: 'therockbottom.co.uk',
      path: '/rafikimedia',
    });
    expect(
      clientServiceContainsUrl(identity, 'https://therockbottom.co.uk/rafikimedia/auth/config'),
    ).toBe(true);
    expect(
      clientServiceContainsUrl(
        'therockbottom.co.uk',
        'https://therockbottom.co.uk/api/auth/config',
      ),
    ).toBe(true);
  });
  it.each([
    'host.test/',
    'host.test/a/',
    'host.test/a//b',
    'host.test/../a',
    'host.test/%61',
    'host.test/A',
    'host.test/a?b',
    'host.test/a#b',
    'host.test:443/a',
    'https://host.test/a',
    'host.test/a\\b',
  ])('rejects ambiguous identity %s', (value) => {
    expect(clientService(value)).toBeNull();
  });
  it.each([
    'https://therockbottom.co.uk/auth/config',
    'https://therockbottom.co.uk/rafikimedia-other/config',
    'https://other.test/rafikimedia/config',
    'https://therockbottom.co.uk/%72afikimedia/config',
    'https://therockbottom.co.uk/other/../rafikimedia/config',
    'https://therockbottom.co.uk/rafikimedia/../config',
    'https://therockbottom.co.uk/rafikimedia/%2e%2e/config',
    'http://therockbottom.co.uk/rafikimedia/config',
    'https://name@therockbottom.co.uk/rafikimedia/config',
    'https://therockbottom.co.uk:444/rafikimedia/config',
  ])('rejects out-of-scope document %s', (url) => {
    expect(() => assertConfigDomainMatchesConfigUrl(identity, url)).toThrow();
  });
  it('validates a complete scoped config while retaining hostname logo checks', () => {
    const config = baseClientConfigPayload({
      domain: identity,
      redirect_urls: ['https://therockbottom.co.uk/rafikimedia/auth/callback'],
    });
    config.ui_theme.logo.url = 'https://therockbottom.co.uk/rafikimedia/logo.png';
    expect(validateConfigFields(config).domain).toBe(identity);
  });
});
