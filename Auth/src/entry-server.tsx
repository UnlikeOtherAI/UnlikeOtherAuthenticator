import React from 'react';
import { renderToString } from 'react-dom/server';

import { App } from './App.js';

function extractSearchFromUrl(value: string): string {
  const idx = value.indexOf('?');
  return idx === -1 ? '' : value.slice(idx);
}

export async function render(_params: {
  config: unknown;
  configUrl: string;
  // Fastify request URL: "/auth?config_url=...&redirect_url=...".
  url?: string;
}): Promise<string> {
  // No client-only globals should be accessed here.
  const initialSearch =
    typeof _params.url === 'string' ? extractSearchFromUrl(_params.url) : '';
  return renderToString(
    <App
      config={_params.config}
      configUrl={_params.configUrl}
      initialSearch={initialSearch}
    />,
  );
}
