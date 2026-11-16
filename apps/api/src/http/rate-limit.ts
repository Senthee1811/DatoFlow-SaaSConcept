import type { Redis } from 'ioredis';

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  retryAfterSeconds: number;
}

/**
 * Fixed-window counter in Redis (NFR-SEC-04). Shared by every API instance.
 * When Redis is down the request is allowed: rate limits must not take the product down.
 */
export async function hit(
  redis: Redis,
  key: string,
  max: number,
  windowSeconds: number,
): Promise<RateLimitResult> {
  try {
    const bucket = Math.floor(Date.now() / 1000 / windowSeconds);
    const redisKey = `rl:${key}:${bucket}`;
    const count = await redis.incr(redisKey);
    if (count === 1) await redis.expire(redisKey, windowSeconds + 1);
    const retryAfterSeconds = windowSeconds - (Math.floor(Date.now() / 1000) % windowSeconds);
    return { allowed: count <= max, remaining: Math.max(0, max - count), retryAfterSeconds };
  } catch {
    return { allowed: true, remaining: max, retryAfterSeconds: 0 };
  }
}
