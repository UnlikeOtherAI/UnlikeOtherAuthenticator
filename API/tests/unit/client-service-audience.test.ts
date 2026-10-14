import { describe, expect, it } from 'vitest';
import { clientServiceHttpsAudience } from '../../src/utils/client-service.js';
describe('exact mounted confidential audiences', () => {
  it('preserves canonical hostname and full mount identities', () => {
    expect(clientServiceHttpsAudience('example.com')).toBe('https://example.com');
    expect(clientServiceHttpsAudience('Example.COM.')).toBe('https://example.com');
    expect(clientServiceHttpsAudience('example.com/client/one')).toBe(
      'https://example.com/client/one',
    );
    expect(clientServiceHttpsAudience('example.com/client/two')).toBe(
      'https://example.com/client/two',
    );
    expect(clientServiceHttpsAudience('example.com/client/one')).not.toBe(
      clientServiceHttpsAudience('example.com'),
    );
  });
  it.each([
    'example.com/client/',
    'example.com/Client',
    'example.com/client//one',
    'example.com/client/../other',
    'example.com/%63lient',
    'example.com:443/client',
    'name@example.com/client',
    'https://example.com/client',
    'example.com/client?other=1',
    'example.com/client#other',
    'example.com/client\\other',
    'example.com:443',
  ])('refuses an ambiguous audience identity %s', (value) => {
    expect(clientServiceHttpsAudience(value)).toBeNull();
  });
});
