import { describe, expect, it } from 'vitest';

import { ALL_PLATFORMS_ID, PLATFORM_KIND_OPTIONS } from './platforms';
import { filterFlagsByPlatform, filterGroupsByPlatform, filterKillSwitchesByPlatform } from './feature-audience';
import { mockAdminData } from './mock-data';

const widgetsApp = requireWidgetsApp();

describe('feature audience platform filtering', () => {
  it('shows every scoped item when all platforms is selected', () => {
    expect(filterFlagsByPlatform(widgetsApp.flagDefinitions, ALL_PLATFORMS_ID).map((flag) => flag.key)).toEqual([
      'integrations_v2',
      'mobile_uploads',
      'usage_export',
      'android_quick_scan',
      'desktop_command_center',
      'kiosk_pairing',
    ]);
    expect(filterKillSwitchesByPlatform(widgetsApp.killSwitches, ALL_PLATFORMS_ID)).toHaveLength(widgetsApp.killSwitches.length);
    expect(filterGroupsByPlatform(widgetsApp.audienceGroups, ALL_PLATFORMS_ID)).toHaveLength(widgetsApp.audienceGroups.length);
  });

  it('filters selected platform rows without hiding all-platform rows', () => {
    expect(filterFlagsByPlatform(widgetsApp.flagDefinitions, 'ios').map((flag) => flag.key)).toEqual(['integrations_v2', 'mobile_uploads']);
    expect(filterKillSwitchesByPlatform(widgetsApp.killSwitches, 'pc').map((killSwitch) => killSwitch.name)).toEqual(['Block unsupported desktop shells']);
    expect(filterGroupsByPlatform(widgetsApp.audienceGroups, 'kiosk').map((group) => group.name)).toEqual(['All dashboard users', 'Kiosk rollout']);
  });

  it('uses the shared platform catalog for native, desktop, and custom kinds', () => {
    expect(PLATFORM_KIND_OPTIONS.map((platform) => platform.value)).toEqual(expect.arrayContaining(['ios', 'android', 'web', 'macos', 'windows', 'linux', 'iot', 'tv', 'console', 'other']));
    expect(widgetsApp.platforms.map((platform) => platform.id)).toEqual(['web', 'ios', 'android', 'mac', 'pc', 'kiosk']);
  });
});

function requireWidgetsApp() {
  const app = mockAdminData.apps.find((item) => item.id === 'app2');

  if (!app) {
    throw new Error('Widgets app mock is missing');
  }

  return app;
}
