import { AuthLayout } from './components/layout/AuthLayout.js';
import { ThemeProvider } from './theme/ThemeProvider.js';
import { readClientBootstrap } from './utils/bootstrap.js';
import { RegisterPage } from './pages/RegisterPage.js';

function AppContent() {
  return (
    <AuthLayout>
      <RegisterPage />
    </AuthLayout>
  );
}

export function App(props?: { config?: unknown; configUrl?: string }) {
  const bootstrap = readClientBootstrap({
    serverConfig: props?.config,
    serverConfigUrl: props?.configUrl,
  });

  return (
    <ThemeProvider config={bootstrap.config} configUrl={bootstrap.configUrl}>
      <AppContent />
    </ThemeProvider>
  );
}
