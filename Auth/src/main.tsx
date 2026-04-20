import React from 'react';
import { createRoot, hydrateRoot } from 'react-dom/client';

import { App } from './App.js';
import './index.css';

const MAX_INITIAL_SEARCH_LENGTH = 4096;
const CONTROL_CHAR_PATTERN = /[\u0000-\u001F\u007F]/;

const container = document.getElementById('root');
if (!container) throw new Error('Missing #root element');

const w = window as unknown as { __UOA_INITIAL_SEARCH__?: string };
const initialSearch = readInitialSearch(w.__UOA_INITIAL_SEARCH__);

function readInitialSearch(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  if (value === '') return '';
  if (value.length > MAX_INITIAL_SEARCH_LENGTH) return undefined;
  if (!value.startsWith('?')) return undefined;
  if (value.includes('#') || CONTROL_CHAR_PATTERN.test(value)) return undefined;

  try {
    new URLSearchParams(value);
    return value;
  } catch {
    return undefined;
  }
}

// In production, the API injects SSR markup into #root for /auth.
// In dev (vite), #root is empty and we use a normal client render.
if (container.childNodes.length > 0) {
  hydrateRoot(
    container,
    <React.StrictMode>
      <App initialSearch={initialSearch} />
    </React.StrictMode>,
  );
} else {
  createRoot(container).render(
    <React.StrictMode>
      <App initialSearch={initialSearch} />
    </React.StrictMode>,
  );
}
