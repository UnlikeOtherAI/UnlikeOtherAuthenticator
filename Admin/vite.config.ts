import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const securityHeaders = {
  'Content-Security-Policy':
    "default-src 'self'; base-uri 'none'; connect-src 'self' https: ws: wss:; font-src 'self' https: data:; form-action 'self'; frame-ancestors 'none'; img-src 'self' https: data:; object-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline' https:",
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Strict-Transport-Security': 'max-age=31536000; includeSubDomains; preload',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
};

export default defineConfig(({ command }) => ({
  base: command === 'build' ? '/admin/' : '/',
  plugins: [react()],
  server: {
    port: 5174,
  },
  preview: {
    headers: securityHeaders,
    port: 4174,
  },
}));
