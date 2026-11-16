import 'reflect-metadata';
import {
  Controller,
  Get,
  Inject,
  Injectable,
  Module,
  type OnApplicationShutdown,
  type OnModuleInit,
  Res,
} from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { createDb, type Db } from '@datoflow/db';
import { LOG_REDACT_PATHS, loadServerEnv, type ServerEnv } from '@datoflow/shared';
import { Queue, Worker } from 'bullmq';
import type { Response } from 'express';
import { Redis } from 'ioredis';
import { pino, type Logger } from 'pino';

/**
 * The background worker. Phase 1 starts it, connects it to Postgres and Redis, and exposes health.
 * The outbox publisher, workflows, reminders, imports, radar and backups arrive in later phases.
 */

const ENV = Symbol('ENV');
const DB = Symbol('DB');
const LOGGER = Symbol('LOGGER');

export const MAINTENANCE_QUEUE = 'maintenance';

@Injectable()
class Queues implements OnModuleInit, OnApplicationShutdown {
  readonly connection: Redis;
  private worker?: Worker;
  private queue?: Queue;

  constructor(
    @Inject(ENV) env: ServerEnv,
    @Inject(LOGGER) private readonly logger: Logger,
  ) {
    // BullMQ workers need maxRetriesPerRequest: null on their connection.
    this.connection = new Redis(env.REDIS_URL, { maxRetriesPerRequest: null });
    this.connection.on('error', (err) => this.logger.warn({ err: err.message }, 'redis error'));
  }

  onModuleInit() {
    this.queue = new Queue(MAINTENANCE_QUEUE, { connection: this.connection });
    this.worker = new Worker(
      MAINTENANCE_QUEUE,
      async (job) => {
        this.logger.info({ jobId: job.id, name: job.name }, 'maintenance job');
        return { ok: true };
      },
      { connection: this.connection, concurrency: 1 },
    );
    this.worker.on('failed', (job, err) =>
      this.logger.error({ jobId: job?.id, err: err.message }, 'job failed'),
    );
    this.logger.info({ queue: MAINTENANCE_QUEUE }, 'worker listening');
  }

  async onApplicationShutdown() {
    await this.worker?.close();
    await this.queue?.close();
    this.connection.disconnect();
  }
}

async function check(fn: () => Promise<unknown>): Promise<'ok' | 'down'> {
  try {
    await Promise.race([
      fn(),
      new Promise((_, r) => setTimeout(() => r(new Error('timeout')), 2000)),
    ]);
    return 'ok';
  } catch {
    return 'down';
  }
}

@Controller('health')
class HealthController {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(Queues) private readonly queues: Queues,
  ) {}

  @Get('live')
  live() {
    return { status: 'ok' };
  }

  @Get('ready')
  async ready(@Res({ passthrough: true }) res: Response) {
    const [database, redis] = await Promise.all([
      check(() => this.db.ping()),
      check(() => this.queues.connection.ping()),
    ]);
    const ok = database === 'ok' && redis === 'ok';
    res.status(ok ? 200 : 503);
    return { status: ok ? 'ok' : 'down', checks: { database, redis } };
  }
}

let env: ServerEnv;
try {
  env = loadServerEnv();
} catch (err) {
  process.stderr.write(`${(err as Error).message}\n`);
  process.exit(1);
}

const logger = pino({ level: 'info', redact: LOG_REDACT_PATHS, base: { service: 'worker' } });
const db = createDb(env.DATABASE_URL);

@Module({
  controllers: [HealthController],
  providers: [
    { provide: ENV, useValue: env },
    { provide: DB, useValue: db },
    { provide: LOGGER, useValue: logger },
    Queues,
  ],
})
class WorkerModule {}

const app = await NestFactory.create(WorkerModule, {
  logger: {
    log: (m) => logger.info(String(m)),
    error: (m) => logger.error(String(m)),
    warn: (m) => logger.warn(String(m)),
  },
});
app.enableShutdownHooks();
await app.listen(env.WORKER_PORT, '0.0.0.0');
