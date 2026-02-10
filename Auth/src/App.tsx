import { PopupContainer } from './components/layout/PopupContainer.js';
import { I18nProvider } from './i18n/I18nProvider.js';
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
      <I18nProvider config={bootstrap.config}>
        <PopupContainer configUrl={bootstrap.configUrl} initialSearch={props?.initialSearch} />
      </I18nProvider>
    </ThemeProvider>
  );
}
