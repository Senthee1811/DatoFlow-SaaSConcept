import { loadServerEnv } from '@datoflow/shared';
import { createApp } from './app.js';

let env;
try {
  env = loadServerEnv();
} catch (err) {
  process.stderr.write(`${(err as Error).message}\n`);
  process.exit(1);
}

const app = await createApp(env);
await app.listen(env.API_PORT, '0.0.0.0');
