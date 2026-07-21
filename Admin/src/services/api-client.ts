import { adminEnv } from '../config/env';
import { readAdminAccessToken } from '../features/auth/admin-session-storage';

export type ApiClient = {
  delete<T>(path: string, init?: RequestInit): Promise<T>;
  get<T>(path: string, init?: RequestInit): Promise<T>;
  getBlob(path: string, init?: RequestInit): Promise<Blob>;
  post<T>(path: string, body?: unknown, init?: RequestInit): Promise<T>;
  postForm<T>(path: string, body: FormData, init?: RequestInit): Promise<T>;
  patch<T>(path: string, body?: unknown, init?: RequestInit): Promise<T>;
  put<T>(path: string, body?: unknown, init?: RequestInit): Promise<T>;
  putForm<T>(path: string, body: FormData, init?: RequestInit): Promise<T>;
};

export class ApiRequestError extends Error {
  public constructor(public readonly status: number) {
    super(`Request failed with HTTP ${status}`);
    this.name = 'ApiRequestError';
  }
}

export function createApiClient(baseUrl = adminEnv.apiBaseUrl): ApiClient {
  async function send(
    method: string,
    path: string,
    body: BodyInit | undefined,
    init: RequestInit | undefined,
    accept: string,
  ): Promise<Response> {
    const resolvedBaseUrl = baseUrl || window.location.origin;
    const requestUrl = new URL(path, resolvedBaseUrl);
    // The admin Bearer is scoped to the auth origin. If a mis-configured
    // VITE_API_BASE_URL resolves cross-origin, refuse to send the request
    // rather than leak the token to another host.
    if (requestUrl.origin !== window.location.origin) {
      throw new Error('Cross-origin admin API requests are not permitted');
    }
    const accessToken = readAdminAccessToken();
    const headers = new Headers(init?.headers);
    headers.set('Accept', accept);
    if (accessToken) headers.set('Authorization', `Bearer ${accessToken}`);

    const response = await fetch(requestUrl, {
      ...init,
      body,
      headers,
      method,
    });

    if (!response.ok) {
      throw new ApiRequestError(response.status);
    }

    return response;
  }

  async function request<T>(method: string, path: string, body?: unknown, init?: RequestInit) {
    const headers = new Headers(init?.headers);
    if (body !== undefined) headers.set('Content-Type', 'application/json');
    const response = await send(
      method,
      path,
      body === undefined ? undefined : JSON.stringify(body),
      { ...init, headers },
      'application/json',
    );

    if (response.status === 204) return undefined as T;
    return response.json() as Promise<T>;
  }

  async function requestForm<T>(method: string, path: string, body: FormData, init?: RequestInit) {
    const response = await send(method, path, body, init, 'application/json');
    return response.json() as Promise<T>;
  }

  return {
    async delete<T>(path: string, init?: RequestInit) {
      return request<T>('DELETE', path, undefined, init);
    },
    async get<T>(path: string, init?: RequestInit) {
      return request<T>('GET', path, undefined, init);
    },
    async getBlob(path: string, init?: RequestInit) {
      const response = await send('GET', path, undefined, init, 'application/pdf');
      return response.blob();
    },
    async post<T>(path: string, body?: unknown, init?: RequestInit) {
      return request<T>('POST', path, body, init);
    },
    async postForm<T>(path: string, body: FormData, init?: RequestInit) {
      return requestForm<T>('POST', path, body, init);
    },
    async patch<T>(path: string, body?: unknown, init?: RequestInit) {
      return request<T>('PATCH', path, body, init);
    },
    async put<T>(path: string, body?: unknown, init?: RequestInit) {
      return request<T>('PUT', path, body, init);
    },
    async putForm<T>(path: string, body: FormData, init?: RequestInit) {
      return requestForm<T>('PUT', path, body, init);
    },
  };
}
