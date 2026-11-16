import { Controller, Get, Inject, Res } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import type { Db } from '@datoflow/db';
import type { Response } from 'express';
import type { Redis } from 'ioredis';
import { Public } from './auth/guards.js';
import { DB, REDIS } from './tokens.js';

async function check(fn: () => Promise<unknown>): Promise<'ok' | 'down'> {
  try {
    await Promise.race([
      fn(),
      new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 2000)),
    ]);
    return 'ok';
  } catch {
    return 'down';
  }
}

/** NFR-OBS-01. Liveness says the process runs; readiness says it can serve requests. */
@ApiExcludeController()
@Public()
@Controller('health')
export class HealthController {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(REDIS) private readonly redis: Redis,
  ) {}

  @Get('live')
  live() {
    return { status: 'ok' };
  }

  @Get('ready')
  async ready(@Res({ passthrough: true }) res: Response) {
    const [database, redis] = await Promise.all([
      check(() => this.db.ping()),
      check(() => this.redis.ping()),
    ]);
    const ok = database === 'ok' && redis === 'ok';
    res.status(ok ? 200 : 503);
    return { status: ok ? 'ok' : 'down', checks: { database, redis } };
  }
}
