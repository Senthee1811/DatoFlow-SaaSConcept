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
import { createEmailAdapter, type EmailAdapter } from '@datoflow/adapters';
import { createDb, runRadar, type Db } from '@datoflow/db';
import { LOG_REDACT_PATHS, type ServerEnv } from '@datoflow/shared';
import { Queue, Worker } from 'bullmq';
import type { Response } from 'express';
import { Redis } from 'ioredis';
import { pino, type Logger } from 'pino';
import { deliverEmails } from './jobs/deliver.js';
import { scanDigests, scanReminders } from './jobs/scan.js';

/**
 * The background worker. BullMQ job schedulers live in Redis (AOF on), so they survive restarts of
 * the worker and of Redis. Every job is safe to run twice: its effects are rows with unique keys.
 * - radar, every 5 minutes: the stuck-lead radar over every organization (TASK-03)
 * - reminders, every minute: reminders, the daily digest and email delivery (TASK-04)
 * The outbox publisher, workflows, imports and backups arrive in later phases.
 */

const ENV = Symbol('ENV');
const DB = Symbol('DB');
const LOGGER = Symbol('LOGGER');
const EMAIL = Symbol('EMAIL');

export const MAINTENANCE_QUEUE = 'maintenance';

export interface Jobs {
  /** The 5-minute radar sweep. */
  radar(now?: Date): Promise<{ flagged: number; cleared: number }>;
  /** The 1-minute run: reminders, digests, then email delivery. */
  reminders(now?: Date): Promise<{
    reminders: number;
    digests: number;
    sent: number;
    skipped: number;
    deferred: number;
    failed: number;
  }>;
}

export function createJobs(deps: {
  env: ServerEnv;
  db: Db;
  redis: Redis;
  email: EmailAdapter;
  logger?: Logger;
}): Jobs {
  return {
    radar: (now = new Date()) => deps.db.withSystem((tx) => runRadar(tx, now)),
    async reminders(now = new Date()) {
      const reminders = await scanReminders(deps.db, now);
      const digests = await scanDigests(deps.db, now);
      const delivered = await deliverEmails(
        deps.db,
        deps.email,
        deps.redis,
        {
          appUrl: deps.env.APP_URL,
          dailyLimit: deps.env.EMAIL_DAILY_LIMIT,
          ...(deps.logger ? { logger: deps.logger } : {}),
        },
        now,
      );
      return { reminders: reminders.created, digests: digests.created, ...delivered };
    },
  };
}

@Injectable()
class Queues implements OnModuleInit, OnApplicationShutdown {
  readonly connection: Redis;
  private worker?: Worker;
  queue?: Queue;
  readonly jobs: Jobs;

  constructor(
    @Inject(ENV) private readonly env: ServerEnv,
    @Inject(DB) db: Db,
    @Inject(EMAIL) email: EmailAdapter,
    @Inject(LOGGER) private readonly logger: Logger,
  ) {
    // BullMQ workers need maxRetriesPerRequest: null on their connection.
    this.connection = new Redis(env.REDIS_URL, { maxRetriesPerRequest: null });
    this.connection.on('error', (err) => this.logger.warn({ err: err.message }, 'redis error'));
    this.jobs = createJobs({ env, db, redis: this.connection, email, logger });
  }

  async onModuleInit() {
    this.queue = new Queue(MAINTENANCE_QUEUE, { connection: this.connection });
    // Upserting by id is idempotent: a restart updates the schedulers, never duplicates them.
    await this.queue.upsertJobScheduler(
      'radar',
      { every: this.env.RADAR_INTERVAL_SECONDS * 1000 },
      { name: 'radar', opts: { removeOnComplete: 100, removeOnFail: 500 } },
    );
    await this.queue.upsertJobScheduler(
      'reminders',
      { every: this.env.REMINDER_INTERVAL_SECONDS * 1000 },
      { name: 'reminders', opts: { removeOnComplete: 100, removeOnFail: 500 } },
    );
    this.worker = new Worker(
      MAINTENANCE_QUEUE,
      async (job) => {
        const started = Date.now();
        const result =
          job.name === 'radar'
            ? await this.jobs.radar()
            : job.name === 'reminders'
              ? await this.jobs.reminders()
              : { ignored: true };
        this.logger.info(
          { jobId: job.id, name: job.name, ms: Date.now() - started, result },
          'job done',
        );
        return result;
      },
      { connection: this.connection, concurrency: 1 },
    );
    this.worker.on('failed', (job, err) =>
      this.logger.error({ jobId: job?.id, name: job?.name, err: err.message }, 'job failed'),
    );
    this.logger.info({ queue: MAINTENANCE_QUEUE }, 'worker listening');
  }

  async onApplicationShutdown() {
    // close() waits for the job in progress, so a planned restart never cuts a send in half.
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

export interface CreateWorkerOptions {
  /** Replaces the adapter chosen by EMAIL_PROVIDER. Tests use it to read sent mail. */
  email?: EmailAdapter;
  logLevel?: string;
}

export async function createWorker(env: ServerEnv, options: CreateWorkerOptions = {}) {
  const logger = pino({
    level: options.logLevel ?? (env.NODE_ENV === 'test' ? 'silent' : 'info'),
    redact: LOG_REDACT_PATHS,
    base: { service: 'worker' },
  });
  const db = createDb(env.DATABASE_URL);
  const email = options.email ?? createEmailAdapter(env);

  @Module({
    controllers: [HealthController],
    providers: [
      { provide: ENV, useValue: env },
      { provide: DB, useValue: db },
      { provide: LOGGER, useValue: logger },
      { provide: EMAIL, useValue: email },
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
  // Starts the schedulers and the BullMQ worker. listen() later only adds the health port.
  await app.init();
  const queues = app.get(Queues);
  return {
    app,
    jobs: queues.jobs,
    queue: () => queues.queue!,
    async close() {
      await app.close();
      await db.disconnect();
    },
  };
}
