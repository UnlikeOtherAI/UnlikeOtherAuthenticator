import { PopupContainer } from './components/layout/PopupContainer.js';
import { I18nProvider } from './i18n/I18nProvider.js';
import { ThemeProvider } from './theme/ThemeProvider.js';
import { AccessStatusContext } from './utils/access-status.js';
import { readClientBootstrap } from './utils/bootstrap.js';

export function App(props?: {
  config?: unknown;
  configUrl?: string;
  initialSearch?: string;
  accessStatusEnabled?: boolean;
}) {
  const bootstrap = readClientBootstrap({
    serverConfig: props?.config,
    serverConfigUrl: props?.configUrl,
    serverAccessStatusEnabled: props?.accessStatusEnabled,
  });

  return (
    <AccessStatusContext.Provider value={bootstrap.accessStatusEnabled}>
      <ThemeProvider config={bootstrap.config} configUrl={bootstrap.configUrl}>
        <I18nProvider config={bootstrap.config} configUrl={bootstrap.configUrl}>
          <PopupContainer
            configUrl={bootstrap.configUrl}
            config={bootstrap.config}
            initialSearch={props?.initialSearch}
          />
        </I18nProvider>
      </ThemeProvider>
    </AccessStatusContext.Provider>
  );
}
