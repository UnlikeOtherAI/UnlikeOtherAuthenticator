import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';

import { App } from './app/App';
import { AppProviders } from './app/AppProviders';
import './index.css';

const root = document.getElementById('root');
const routerBasename = import.meta.env.BASE_URL.replace(/\/$/, '') || undefined;

if (!root) {
  throw new Error('Root element not found.');
}

createRoot(root).render(
  <StrictMode>
    <BrowserRouter basename={routerBasename}>
      <AppProviders>
        <App />
      </AppProviders>
    </BrowserRouter>
  </StrictMode>,
);
