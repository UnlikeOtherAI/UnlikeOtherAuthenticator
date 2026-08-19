import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// Production-representative CSP, sent by `vite preview` against the built app.
const previewHeaders = {
  'Content-Security-Policy':
    "default-src 'self'; base-uri 'none'; connect-src 'self' https:; font-src 'self' https: data:; form-action 'self'; frame-ancestors 'none'; frame-src 'self' blob:; img-src 'self' https: data:; object-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline' https:; upgrade-insecure-requests",
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Strict-Transport-Security': 'max-age=31536000; includeSubDomains; preload',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
};

// Dev-server CSP: identical to preview except script-src also allows
// 'unsafe-inline'. Required in dev because @vitejs/plugin-react injects its
// React Fast Refresh preamble as an inline <script type="module"> with no
// nonce or hash; without 'unsafe-inline' the browser blocks it and every
// component module then fails with "can't detect preamble". Do not remove it
// from the dev server — preview keeps the strict policy.
const devHeaders = {
  ...previewHeaders,
  'Content-Security-Policy':
    "default-src 'self'; base-uri 'none'; connect-src 'self' https:; font-src 'self' https: data:; form-action 'self'; frame-ancestors 'none'; frame-src 'self' blob:; img-src 'self' https: data:; object-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline' https:; upgrade-insecure-requests",
};

export default defineConfig({
  plugins: [react()],
  server: {
    headers: devHeaders,
    port: 5173,
  },
  preview: {
    headers: previewHeaders,
  },
});
