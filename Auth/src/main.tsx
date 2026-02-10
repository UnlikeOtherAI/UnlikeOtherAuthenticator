import React from 'react';
import { createRoot, hydrateRoot } from 'react-dom/client';

import { App } from './App.js';
import './index.css';

const container = document.getElementById('root');
if (!container) throw new Error('Missing #root element');

// In production, the API injects SSR markup into #root for /auth.
// In dev (vite), #root is empty and we use a normal client render.
if (container.childNodes.length > 0) {
  hydrateRoot(
    container,
    <React.StrictMode>
      <App />
    </React.StrictMode>,
  );
} else {
  createRoot(container).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>,
  );
}
