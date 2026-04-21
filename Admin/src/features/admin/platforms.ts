import type { AppFlagSummary, AppPlatformKind, FeaturePlatform } from './types';

export const ALL_PLATFORMS_ID = 'all';

export const PLATFORM_KIND_OPTIONS: Array<{ label: string; value: AppPlatformKind }> = [
  { label: 'iOS', value: 'ios' },
  { label: 'Android', value: 'android' },
  { label: 'Web', value: 'web' },
  { label: 'Mac', value: 'macos' },
  { label: 'PC / Windows', value: 'windows' },
  { label: 'Linux', value: 'linux' },
  { label: 'IoT / Embedded', value: 'iot' },
  { label: 'TV', value: 'tv' },
  { label: 'Game Console', value: 'console' },
  { label: 'Custom / Other', value: 'other' },
];

export function createFeaturePlatform(kind: AppPlatformKind, options: { id?: string; name?: string; key?: string; identifier?: string } = {}): FeaturePlatform {
  const catalogItem = PLATFORM_KIND_OPTIONS.find((item) => item.value === kind);
  const key = options.key ?? options.id ?? kind;

  return {
    id: options.id ?? key,
    key,
    name: options.name ?? catalogItem?.label ?? key,
    kind,
    identifier: options.identifier,
  };
}

export function platformKindLabel(kind: AppPlatformKind) {
  return PLATFORM_KIND_OPTIONS.find((item) => item.value === kind)?.label ?? kind;
}

export function isAllPlatformsSelection(platformId: string) {
  return platformId === ALL_PLATFORMS_ID;
}

export function platformNames(app: AppFlagSummary, platformIds: string[]) {
  return platformIds
    .map((platformId) => app.platforms.find((platform) => platform.id === platformId)?.name)
    .filter(Boolean)
    .join(', ');
}

