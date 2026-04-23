import { adminEnv } from '../config/env';
import { readAdminAccessToken } from '../features/auth/admin-session-storage';

export type ApiClient = {
  delete<T>(path: string, init?: RequestInit): Promise<T>;
  get<T>(path: string, init?: RequestInit): Promise<T>;
  post<T>(path: string, body?: unknown, init?: RequestInit): Promise<T>;
  patch<T>(path: string, body?: unknown, init?: RequestInit): Promise<T>;
  put<T>(path: string, body?: unknown, init?: RequestInit): Promise<T>;
};

export function createApiClient(baseUrl = adminEnv.apiBaseUrl): ApiClient {
  async function request<T>(method: string, path: string, body?: unknown, init?: RequestInit) {
    const resolvedBaseUrl = baseUrl || window.location.origin;
    const accessToken = readAdminAccessToken();
    const headers = new Headers(init?.headers);
    headers.set('Accept', 'application/json');
    if (body !== undefined) headers.set('Content-Type', 'application/json');
    if (accessToken) headers.set('Authorization', `Bearer ${accessToken}`);

    const response = await fetch(new URL(path, resolvedBaseUrl), {
      ...init,
      body: body === undefined ? undefined : JSON.stringify(body),
      headers,
      method,
    });

    if (!response.ok) {
      throw new Error('Request failed');
    }

    if (response.status === 204) return undefined as T;
    return response.json() as Promise<T>;
  }

  return {
    async delete<T>(path: string, init?: RequestInit) {
      return request<T>('DELETE', path, undefined, init);
    },
    async get<T>(path: string, init?: RequestInit) {
      return request<T>('GET', path, undefined, init);
    },
    async post<T>(path: string, body?: unknown, init?: RequestInit) {
      return request<T>('POST', path, body, init);
    },
    async patch<T>(path: string, body?: unknown, init?: RequestInit) {
      return request<T>('PATCH', path, body, init);
    },
    async put<T>(path: string, body?: unknown, init?: RequestInit) {
      return request<T>('PUT', path, body, init);
    },
  };
}
