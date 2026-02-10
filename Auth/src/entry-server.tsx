import React from 'react';
import { renderToString } from 'react-dom/server';

import { App } from './App.js';

export async function render(_params: {
  config: unknown;
  configUrl: string;
}): Promise<string> {
  // No client-only globals should be accessed here.
  return renderToString(<App config={_params.config} configUrl={_params.configUrl} />);
}
