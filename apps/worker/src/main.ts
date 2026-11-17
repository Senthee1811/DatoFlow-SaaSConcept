import { loadServerEnv, type ServerEnv } from '@datoflow/shared';
import { createWorker } from './worker.js';

let env: ServerEnv;
try {
  env = loadServerEnv();
} catch (err) {
  process.stderr.write(`${(err as Error).message}\n`);
  process.exit(1);
}

const worker = await createWorker(env);
await worker.app.listen(env.WORKER_PORT, '0.0.0.0');
