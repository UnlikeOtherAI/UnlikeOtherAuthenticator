/// <reference types="vite/client" />

declare global {
  interface Window {
    __UOA_CLIENT_CONFIG__?: unknown;
    __UOA_CONFIG_URL__?: string;
  }
}

export {};
