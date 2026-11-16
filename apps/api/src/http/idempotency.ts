import {
  type CallHandler,
  type ExecutionContext,
  Inject,
  Injectable,
  type NestInterceptor,
} from '@nestjs/common';
import { ErrorCode } from '@datoflow/shared';
import { createHash } from 'node:crypto';
import type { Request, Response } from 'express';
import type { Redis } from 'ioredis';
import { from, of, type Observable } from 'rxjs';
import { catchError, mergeMap, tap } from 'rxjs/operators';
import { REDIS } from '../tokens.js';
import { ApiError } from './errors.js';
import { clientIp } from './request.js';

const TTL_SECONDS = 24 * 60 * 60;
const KEY_PATTERN = /^[A-Za-z0-9_.:-]{8,255}$/;

interface Stored {
  state: 'pending' | 'done';
  bodyHash: string;
  status?: number;
  response?: unknown;
}

/**
 * `Idempotency-Key` on POST requests. The first response is kept for 24 hours and replayed for
 * the same key and body. The same key with a different body is a 422. Errors are not kept,
 * so a failed request can be retried with the same key.
 */
@Injectable()
export class IdempotencyInterceptor implements NestInterceptor {
  constructor(@Inject(REDIS) private readonly redis: Redis) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const req = context.switchToHttp().getRequest<Request>();
    const res = context.switchToHttp().getResponse<Response>();
    const key = req.get('idempotency-key');
    if (req.method !== 'POST' || !key) return next.handle();
    if (!KEY_PATTERN.test(key)) {
      throw ApiError.validation([
        { path: 'header.Idempotency-Key', message: 'Use 8 to 255 letters, digits, _ . : or -' },
      ]);
    }

    const who = req.user?.id ?? `ip:${clientIp(req)}`;
    const redisKey = `idem:${who}:${req.originalUrl}:${key}`;
    const bodyHash = createHash('sha256')
      .update(JSON.stringify(req.body ?? null))
      .digest('hex');

    return from(this.claim(redisKey, bodyHash)).pipe(
      mergeMap((existing) => {
        if (existing) {
          if (existing.bodyHash !== bodyHash) {
            throw new ApiError(
              422,
              ErrorCode.IDEMPOTENCY_KEY_REUSED,
              'This Idempotency-Key was already used with a different body',
            );
          }
          if (existing.state === 'pending') {
            throw new ApiError(409, ErrorCode.CONFLICT, 'A request with this key is still running');
          }
          res.status(existing.status ?? 200).setHeader('idempotent-replayed', 'true');
          return of(existing.response);
        }
        return next.handle().pipe(
          tap((response) => {
            const stored: Stored = { state: 'done', bodyHash, status: res.statusCode, response };
            void this.redis
              .set(redisKey, JSON.stringify(stored), 'EX', TTL_SECONDS)
              .catch(() => {});
          }),
          catchError((err: unknown) => {
            void this.redis.del(redisKey).catch(() => {});
            throw err;
          }),
        );
      }),
    );
  }

  /** Returns the stored entry, or null after claiming the key for this request. */
  private async claim(redisKey: string, bodyHash: string): Promise<Stored | null> {
    const pending: Stored = { state: 'pending', bodyHash };
    const claimed = await this.redis.set(redisKey, JSON.stringify(pending), 'EX', 60, 'NX');
    if (claimed === 'OK') return null;
    const raw = await this.redis.get(redisKey);
    return raw ? (JSON.parse(raw) as Stored) : null;
  }
}
