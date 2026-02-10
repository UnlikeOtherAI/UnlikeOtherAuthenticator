function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function readWindowBootstrap(): { config: unknown; configUrl: string } {
  if (typeof window === 'undefined') return { config: {}, configUrl: '' };

  const w = window as unknown as {
    __UOA_CLIENT_CONFIG__?: unknown;
    __UOA_CONFIG_URL__?: unknown;
  };

  const config = w.__UOA_CLIENT_CONFIG__ ?? {};
  const configUrl = typeof w.__UOA_CONFIG_URL__ === 'string' ? w.__UOA_CONFIG_URL__ : '';
  return { config, configUrl };
}

export function readClientBootstrap(params?: {
  serverConfig?: unknown;
  serverConfigUrl?: string;
}): { config: unknown; configUrl: string } {
  // SSR render passes config explicitly; client render reads from window bootstrap injected by API.
  if (params?.serverConfig !== undefined) {
    return {
      config: isRecord(params.serverConfig) ? params.serverConfig : {},
      configUrl: typeof params.serverConfigUrl === 'string' ? params.serverConfigUrl : '',
    };
  }

  return readWindowBootstrap();
}

