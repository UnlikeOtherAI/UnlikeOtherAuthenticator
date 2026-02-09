import { createApp } from './app.js';
import { getEnv } from './config/env.js';

const env = getEnv();
const app = await createApp();

const shutdown = async (signal: NodeJS.Signals): Promise<void> => {
  app.log.info({ signal }, 'shutting down');
  await app.close();
  process.exit(0);
};

(['SIGINT', 'SIGTERM'] as const).forEach((signal) => {
  process.on(signal, () => {
    void shutdown(signal);
  });
});

try {
  await app.listen({ port: env.PORT, host: env.HOST });
} catch (err) {
  app.log.error({ err }, 'failed to start server');
  process.exit(1);
}

