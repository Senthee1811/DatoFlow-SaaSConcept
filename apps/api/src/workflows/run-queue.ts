import { Inject, Injectable, type OnApplicationShutdown } from '@nestjs/common';
import { jobId, WORKFLOW_QUEUE } from '@datoflow/workflow';
import { Queue } from 'bullmq';
import type { Redis } from 'ioredis';
import type { Logger } from 'pino';
import { LOGGER, REDIS } from '../tokens.js';

/**
 * Puts a manually retried run on the worker's queue at once. If Redis is unreachable the run stays
 * QUEUED in the database and the worker's sweep picks it up within a minute, so a failure here is
 * logged, never returned to the caller.
 */
@Injectable()
export class RunQueue implements OnApplicationShutdown {
  private queue?: Queue;

  constructor(
    @Inject(REDIS) private readonly redis: Redis,
    @Inject(LOGGER) private readonly logger: Logger,
  ) {}

  async enqueueRun(executionId: string, round: number) {
    try {
      this.queue ??= new Queue(WORKFLOW_QUEUE, { connection: this.redis });
      await this.queue.add(
        'run',
        { executionId },
        { jobId: jobId.run(executionId, round, 0), removeOnComplete: 1000, removeOnFail: 1000 },
      );
    } catch (err) {
      this.logger.warn({ executionId, err: (err as Error).message }, 'could not queue the retry');
    }
  }

  async onApplicationShutdown() {
    await this.queue?.close();
  }
}
