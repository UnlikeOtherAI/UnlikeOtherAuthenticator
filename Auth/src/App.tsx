import { PopupContainer } from './components/layout/PopupContainer.js';
import { ThemeProvider } from './theme/ThemeProvider.js';
import { readClientBootstrap } from './utils/bootstrap.js';

export function App(props?: {
  config?: unknown;
  configUrl?: string;
  initialSearch?: string;
}) {
  const bootstrap = readClientBootstrap({
    serverConfig: props?.config,
    serverConfigUrl: props?.configUrl,
  });

  return (
    <ThemeProvider config={bootstrap.config} configUrl={bootstrap.configUrl}>
      <PopupContainer configUrl={bootstrap.configUrl} initialSearch={props?.initialSearch} />
    </ThemeProvider>
  );
}
