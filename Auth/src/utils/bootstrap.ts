function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function readWindowBootstrap(): { config: unknown; configUrl: string; accessStatusEnabled: boolean } {
  if (typeof window === 'undefined') return { config: {}, configUrl: '', accessStatusEnabled: false };

  const w = window as unknown as {
    __UOA_CLIENT_CONFIG__?: unknown;
    __UOA_CONFIG_URL__?: unknown;
    __UOA_ACCESS_STATUS_ENABLED__?: unknown;
  };

  const config = w.__UOA_CLIENT_CONFIG__ ?? {};
  const configUrl = typeof w.__UOA_CONFIG_URL__ === 'string' ? w.__UOA_CONFIG_URL__ : '';
  return { config, configUrl, accessStatusEnabled: w.__UOA_ACCESS_STATUS_ENABLED__ === true };
}

export function readClientBootstrap(params?: {
  serverConfig?: unknown;
  serverConfigUrl?: string;
  serverAccessStatusEnabled?: boolean;
}): { config: unknown; configUrl: string; accessStatusEnabled: boolean } {
  // SSR render passes config explicitly; client render reads from window bootstrap injected by API.
  if (params?.serverConfig !== undefined) {
    return {
      config: isRecord(params.serverConfig) ? params.serverConfig : {},
      configUrl: typeof params.serverConfigUrl === 'string' ? params.serverConfigUrl : '',
      accessStatusEnabled: params.serverAccessStatusEnabled === true,
    };
  }

  return readWindowBootstrap();
}

