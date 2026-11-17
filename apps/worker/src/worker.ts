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
import { jobId, WORKFLOW_QUEUE } from '@datoflow/workflow';
import { deliverEmails } from './jobs/deliver.js';
import { scanDigests, scanReminders } from './jobs/scan.js';
import {
  dispatchEvent,
  publishOutbox,
  raiseDeadlineEvents,
  runExecution,
  sweepExecutions,
  type EngineDeps,
  type FaultHook,
  type RunOutcome,
  type SweepResult,
} from './workflow/engine.js';

/**
 * The background worker. BullMQ job schedulers live in Redis (AOF on), so they survive restarts of
 * the worker and of Redis. Every job is safe to run twice: its effects are rows with unique keys.
 * - radar, every 5 minutes: the stuck-lead radar over every organization (TASK-03)
 * - reminders, every minute: reminders, the daily digest, task.deadline_reached events and
 *   email delivery (TASK-04, WF-02)
 * And on the workflows queue (Phase 4):
 * - publish, every WORKFLOW_POLL_MS: the outbox publisher, one dispatch job per event
 * - dispatch: turns an event into runs; run: executes one run, queued again with backoff on failure
 * - sweep, every WORKFLOW_SWEEP_SECONDS: recovers runs whose worker stopped, and lost jobs
 * Imports and backups arrive in later phases.
 */

const ENV = Symbol('ENV');
const DB = Symbol('DB');
const LOGGER = Symbol('LOGGER');
const EMAIL = Symbol('EMAIL');
const OPTIONS = Symbol('OPTIONS');

export const MAINTENANCE_QUEUE = 'maintenance';
export type { FaultHook, RunOutcome } from './workflow/engine.js';

export interface Jobs {
  /** The 5-minute radar sweep. */
  radar(now?: Date): Promise<{ flagged: number; cleared: number }>;
  /** The 1-minute run: reminders, digests, then email delivery. */
  reminders(now?: Date): Promise<{
    reminders: number;
    digests: number;
    deadlines: number;
    sent: number;
    skipped: number;
    deferred: number;
    failed: number;
  }>;
  /** Moves unpublished outbox events to the workflow queue. */
  publish(): Promise<number>;
  /** Turns one event into runs and queues them. Returns the queued run ids. */
  dispatch(eventId: string, now?: Date): Promise<string[]>;
  /** Runs one execution; a failed attempt is queued again after its backoff. */
  run(executionId: string, now?: Date): Promise<RunOutcome>;
  /** Recovers interrupted runs and queues runs that lost their job. */
  sweep(now?: Date): Promise<SweepResult>;
}

export function createJobs(deps: {
  env: ServerEnv;
  db: Db;
  redis: Redis;
  email: EmailAdapter;
  logger?: Logger;
  /** The workflow queue. Jobs are added here; the BullMQ worker processes them. */
  workflowQueue: () => Queue;
  faults?: FaultHook;
  random?: () => number;
}): Jobs {
  const engine: EngineDeps = {
    db: deps.db,
    backoff: { baseMs: deps.env.WORKFLOW_RETRY_BASE_MS, capMs: 60 * 60_000 },
    leaseMs: deps.env.WORKFLOW_LEASE_SECONDS * 1000,
    ...(deps.logger ? { logger: deps.logger } : {}),
    ...(deps.faults ? { faults: deps.faults } : {}),
    ...(deps.random ? { random: deps.random } : {}),
  };
  const keep = { removeOnComplete: 1000, removeOnFail: 5000 };
  const queueRun = (executionId: string, round: number, attempt: number, delay = 0, suffix = '') =>
    deps.workflowQueue().add(
      'run',
      { executionId },
      {
        jobId: jobId.run(executionId, round, attempt) + suffix,
        delay: Math.max(0, delay),
        ...keep,
      },
    );
  return {
    radar: (now = new Date()) => deps.db.withSystem((tx) => runRadar(tx, now)),
    async reminders(now = new Date()) {
      const reminders = await scanReminders(deps.db, now);
      const digests = await scanDigests(deps.db, now);
      const deadlines = await raiseDeadlineEvents(deps.db, now);
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
      return { reminders: reminders.created, digests: digests.created, deadlines, ...delivered };
    },
    publish: () =>
      publishOutbox(deps.db, async (eventIds) => {
        await deps.workflowQueue().addBulk(
          eventIds.map((eventId) => ({
            name: 'dispatch',
            data: { eventId },
            // A dispatch that fails (database down) is retried by BullMQ; it is idempotent.
            opts: {
              jobId: jobId.event(eventId),
              attempts: 10,
              backoff: { type: 'exponential', delay: 1000 },
              ...keep,
            },
          })),
        );
      }),
    async dispatch(eventId, now = new Date()) {
      const queued = await dispatchEvent(engine, eventId, now);
      for (const id of queued) await queueRun(id, 0, 0);
      return queued;
    },
    async run(executionId, now = new Date()) {
      const outcome = await runExecution(engine, executionId, now);
      if (outcome.status === 'FAILED') {
        await queueRun(
          executionId,
          outcome.round,
          outcome.attempt,
          outcome.retryAt.getTime() - Date.now(),
        );
      }
      return outcome;
    },
    async sweep(now = new Date()) {
      const result = await sweepExecutions(engine, now);
      // A distinct job id: the claim, not the id, keeps a run from starting twice.
      for (const r of result.requeue) {
        await queueRun(r.executionId, r.round, r.attempt, 0, `-sweep-${now.getTime()}`);
      }
      return result;
    },
  };
}

@Injectable()
class Queues implements OnModuleInit, OnApplicationShutdown {
  readonly connection: Redis;
  private worker?: Worker;
  private workflowWorker?: Worker;
  queue?: Queue;
  workflowQueue?: Queue;
  readonly jobs: Jobs;

  constructor(
    @Inject(ENV) private readonly env: ServerEnv,
    @Inject(DB) db: Db,
    @Inject(EMAIL) email: EmailAdapter,
    @Inject(LOGGER) private readonly logger: Logger,
    @Inject(OPTIONS) options: CreateWorkerOptions,
  ) {
    // BullMQ workers need maxRetriesPerRequest: null on their connection.
    this.connection = new Redis(env.REDIS_URL, { maxRetriesPerRequest: null });
    this.connection.on('error', (err) => this.logger.warn({ err: err.message }, 'redis error'));
    this.jobs = createJobs({
      env,
      db,
      redis: this.connection,
      email,
      logger,
      workflowQueue: () => this.workflowQueue!,
      ...(options.faults ? { faults: options.faults } : {}),
      ...(options.random ? { random: options.random } : {}),
    });
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

    this.workflowQueue = new Queue(WORKFLOW_QUEUE, { connection: this.connection });
    await this.workflowQueue.upsertJobScheduler(
      'publish',
      { every: this.env.WORKFLOW_POLL_MS },
      { name: 'publish', opts: { removeOnComplete: 10, removeOnFail: 100 } },
    );
    await this.workflowQueue.upsertJobScheduler(
      'sweep',
      { every: this.env.WORKFLOW_SWEEP_SECONDS * 1000 },
      { name: 'sweep', opts: { removeOnComplete: 10, removeOnFail: 100 } },
    );
    this.workflowWorker = new Worker(
      WORKFLOW_QUEUE,
      async (job) => {
        switch (job.name) {
          case 'publish':
            return this.jobs.publish();
          case 'dispatch':
            return this.jobs.dispatch(String(job.data.eventId));
          case 'run': {
            const outcome = await this.jobs.run(String(job.data.executionId));
            if (outcome.status !== 'NOT_CLAIMED') {
              this.logger.info(
                { executionId: job.data.executionId, outcome: outcome.status },
                'workflow run',
              );
            }
            return outcome;
          }
          case 'sweep': {
            const result = await this.jobs.sweep();
            if (result.requeue.length || result.interrupted) {
              this.logger.info(
                { requeued: result.requeue.length, interrupted: result.interrupted },
                'workflow sweep',
              );
            }
            return { requeued: result.requeue.length, interrupted: result.interrupted };
          }
          default:
            return { ignored: true };
        }
      },
      { connection: this.connection, concurrency: this.env.WORKFLOW_CONCURRENCY },
    );
    this.workflowWorker.on('failed', (job, err) =>
      this.logger.error(
        { jobId: job?.id, name: job?.name, err: err.message },
        'workflow job failed',
      ),
    );
    this.logger.info({ queues: [MAINTENANCE_QUEUE, WORKFLOW_QUEUE] }, 'worker listening');
  }

  async onApplicationShutdown() {
    // close() waits for the job in progress, so a planned restart never cuts a send in half.
    await this.workflowWorker?.close();
    await this.worker?.close();
    await this.workflowQueue?.close();
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
  /** Tests only: called before each workflow action; throwing fails the step (WF-08). */
  faults?: FaultHook;
  /** Tests only: the jitter source for retry backoff. */
  random?: () => number;
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
      { provide: OPTIONS, useValue: options },
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
    workflowQueue: () => queues.workflowQueue!,
    async close() {
      await app.close();
      await db.disconnect();
    },
  };
}
