import { describe, expect, it, vi } from 'vitest';

import { getAppStartup } from '../app-startup.service.js';
import type { getEnv } from '../../config/env.js';

type StartupDeps = Parameters<typeof getAppStartup>[1];

function testEnv() {
  return { DATABASE_URL: 'postgresql://example' } as ReturnType<typeof getEnv>;
}

function makeApp(overrides: Record<string, unknown> = {}) {
  return {
    id: 'app_1',
    orgId: 'org_1',
    storeUrl: 'https://example.com/store',
    active: true,
    featureFlagsEnabled: true,
    ...overrides,
  };
}

function makePrisma(overrides: {
  app?: unknown;
  definitions?: unknown[];
  overrides?: unknown[];
  killSwitches?: unknown[];
  membership?: unknown;
} = {}) {
  const appFindFirst = vi.fn(async () => overrides.app ?? makeApp());
  const definitionFindMany = vi.fn(async () => overrides.definitions ?? []);
  const overrideFindMany = vi.fn(async () => overrides.overrides ?? []);
  const killSwitchFindMany = vi.fn(async () => overrides.killSwitches ?? []);
  const orgMemberFindFirst = vi.fn(async () => overrides.membership ?? { id: 'member_1' });

  return {
    mocks: {
      appFindFirst,
      definitionFindMany,
      overrideFindMany,
      killSwitchFindMany,
      orgMemberFindFirst,
    },
    prisma: {
      app: { findFirst: appFindFirst },
      featureFlagDefinition: { findMany: definitionFindMany },
      featureFlagUserOverride: { findMany: overrideFindMany },
      killSwitchEntry: { findMany: killSwitchFindMany },
      orgMember: { findFirst: orgMemberFindFirst },
    } as unknown as StartupDeps['prisma'],
  };
}

describe('getAppStartup', () => {
  it('returns a clear startup response when the database is disabled', async () => {
    const { prisma, mocks } = makePrisma();

    const response = await getAppStartup(
      { domain: 'app.example.com', appIdentifier: 'com.example.app', platform: 'ios' },
      { env: { DATABASE_URL: undefined } as ReturnType<typeof getEnv>, prisma },
    );

    expect(response.killSwitch).toBeNull();
    expect(response.flags).toEqual({});
    expect(response.cacheTtl).toBe(3600);
    expect(mocks.appFindFirst).not.toHaveBeenCalled();
  });

  it('returns default flags plus per-user overrides for org members', async () => {
    const { prisma } = makePrisma({
      definitions: [
        { key: 'dark_mode', defaultState: false },
        { key: 'new_checkout', defaultState: true },
      ],
      overrides: [{ flagKey: 'dark_mode', value: true }],
    });

    const response = await getAppStartup(
      {
        domain: 'App.Example.com',
        appIdentifier: 'COM.EXAMPLE.APP',
        platform: 'ios',
        userId: 'user_1',
      },
      { env: testEnv(), prisma },
    );

    expect(response.flags).toEqual({ dark_mode: true, new_checkout: true });
  });

  it('selects the highest-priority active kill switch', async () => {
    const createdAt = new Date('2026-04-22T10:00:00.000Z');
    const { prisma } = makePrisma({
      killSwitches: [
        {
          id: 'ks_low',
          platform: 'ios',
          type: 'soft',
          versionField: 'versionName',
          operator: 'lte',
          versionValue: '2.0.0',
          versionMax: null,
          versionScheme: 'semver',
          active: true,
          activateAt: null,
          deactivateAt: null,
          priority: 1,
          createdAt,
          testUserIds: [],
          titleKey: null,
          title: 'Soft update',
          messageKey: null,
          message: null,
          primaryButtonKey: null,
          primaryButton: null,
          secondaryButtonKey: null,
          secondaryButton: null,
          storeUrl: null,
          latestVersion: '2.0.0',
          cacheTtl: 600,
        },
        {
          id: 'ks_high',
          platform: 'ios',
          type: 'hard',
          versionField: 'versionName',
          operator: 'lte',
          versionValue: '2.0.0',
          versionMax: null,
          versionScheme: 'semver',
          active: true,
          activateAt: null,
          deactivateAt: null,
          priority: 10,
          createdAt,
          testUserIds: [],
          titleKey: null,
          title: 'Required update',
          messageKey: null,
          message: null,
          primaryButtonKey: null,
          primaryButton: null,
          secondaryButtonKey: null,
          secondaryButton: null,
          storeUrl: null,
          latestVersion: '2.1.0',
          cacheTtl: 300,
        },
      ],
    });

    const response = await getAppStartup(
      {
        domain: 'app.example.com',
        appIdentifier: 'com.example.app',
        platform: 'ios',
        versionName: '1.5.0',
      },
      { env: testEnv(), prisma },
    );

    expect(response.killSwitch).toMatchObject({
      id: 'ks_high',
      type: 'hard',
      title: 'Required update',
      latestVersion: '2.1.0',
      cacheTtl: 300,
    });
    expect(response.cacheTtl).toBe(300);
  });
});
