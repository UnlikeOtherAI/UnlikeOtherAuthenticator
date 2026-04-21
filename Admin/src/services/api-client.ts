import { adminEnv } from '../config/env';

export type ApiClient = {
  get<T>(path: string, init?: RequestInit): Promise<T>;
};

export function createApiClient(baseUrl = adminEnv.apiBaseUrl): ApiClient {
  return {
    async get<T>(path: string, init?: RequestInit) {
      if (!baseUrl) {
        throw new Error('VITE_API_BASE_URL is not configured.');
      }

      const response = await fetch(new URL(path, baseUrl), {
        ...init,
        headers: {
          Accept: 'application/json',
          ...init?.headers,
        },
      });

      if (!response.ok) {
        throw new Error('Request failed');
      }

      return response.json() as Promise<T>;
    },
  };
}
