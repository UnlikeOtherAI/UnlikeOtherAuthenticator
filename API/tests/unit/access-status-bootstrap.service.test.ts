import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderAuthEntrypointHtml } from '../../src/services/auth-ui.service.js';
import { validateConfigFields } from '../../src/services/config.service.js';
import { baseClientConfigPayload } from '../helpers/test-config.js';

const config = validateConfigFields(baseClientConfigPayload({ debug_enabled: true }));
afterEach(() => vi.unstubAllEnvs());
describe('Auth server-owned diagnostic bootstrap', () => {
  it.each([undefined, 'false', 'true'])(
    'keeps SSR and hydration consistent for %s',
    async (flag) => {
      vi.stubEnv('AUTH_ACCESS_STATUS_ENABLED', flag);
      for (const search of [
        'config_url=https://client.example.com/config&access_status_enabled=true',
        'client_id=native-client&redirect_uri=com.example.app:/callback',
      ]) {
        const html = await renderAuthEntrypointHtml({
          config,
          configUrl: 'https://client.example.com/config',
          requestUrl: `/auth?${search}`,
          cspNonce: 'a123',
        });
        const enabled = flag === 'true';
        expect(html).toContain(`window.__UOA_ACCESS_STATUS_ENABLED__ = ${enabled};`);
        expect(html.includes('Check access status')).toBe(enabled);
        expect(html).toContain('<script nonce="a123">');
        expect(html.indexOf('window.__UOA_ACCESS_STATUS_ENABLED__')).toBeLessThan(
          html.indexOf('<script type="module"'),
        );
      }
    },
  );
});
