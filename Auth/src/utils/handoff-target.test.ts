import { describe, expect, it } from 'vitest';
import { selectAllowedHandoffTarget } from './handoff-target.js';
const config = {
  redirect_urls: ['example://oauth/callback?fixed=1', 'https://product.example/callback'],
};
describe('server-resolved handoff destination', () => {
  it('preserves the exact callback, code and opaque state', () => {
    const target = 'example://oauth/callback?fixed=1&code=one-use&state=opaque';
    expect(selectAllowedHandoffTarget(config, target)).toBe(target);
    expect(
      selectAllowedHandoffTarget(config, 'example://oauth/callback?fixed=1&error=access_denied'),
    ).not.toBeNull();
  });
  it('preserves registered HTTPS cancellation and completion callbacks', () => {
    for (const response of ['code=one-use', 'error=access_denied&state=opaque']) {
      const target = `https://product.example/callback?${response}`;
      expect(selectAllowedHandoffTarget(config, target)).toBe(target);
    }
  });
  it.each([
    'https://attacker.example/',
    'https://product.example/other-callback?code=x',
    'evil://oauth/callback?code=x',
    'example://other/callback?fixed=1&code=x',
    'example://oauth/callback?fixed=2&code=x',
    'example://oauth/callback?fixed=1&code=x&extra=1',
    'javascript:alert(1)',
    'not a url',
  ])('refuses query-controlled %s', (target) => {
    expect(selectAllowedHandoffTarget(config, target)).toBeNull();
  });
});
