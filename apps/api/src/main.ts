import 'reflect-metadata';
import { createApp } from './bootstrap';
import { loadConfig } from './config/config';

async function main(): Promise<void> {
  const cfg = loadConfig();
  const app = await createApp(cfg);
  await app.listen(cfg.PORT, '0.0.0.0');
}

main().catch((err: unknown) => {
  // Config errors list variable names only, never values.
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
