import { AuthLayout } from './components/layout/AuthLayout.js';
import { Button } from './components/ui/Button.js';
import { useTheme } from './hooks/use-theme.js';
import { ThemeProvider } from './theme/ThemeProvider.js';
import { readClientBootstrap } from './utils/bootstrap.js';

function AppContent() {
  const { classNames } = useTheme();

  return (
    <AuthLayout>
      <h1 className={`text-balance ${classNames.title}`}>Auth Window</h1>
      <p className="mt-2 text-pretty text-[var(--uoa-color-muted)]">
        Theme engine scaffold. UI styling is sourced from the signed config JWT payload
        via <code className="font-mono text-xs">ui_theme</code>.
      </p>

      <div className="mt-6 flex flex-col gap-3">
        <Button variant="primary" type="button">
          Primary Action
        </Button>
        <Button variant="secondary" type="button">
          Secondary Action
        </Button>
      </div>
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
