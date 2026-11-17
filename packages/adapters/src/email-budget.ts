import type { EmailAdapter } from './email.js';

/** The part of a Redis client the budget needs. ioredis fits it. */
export interface Counter {
  incr(key: string): Promise<number>;
  get(key: string): Promise<string | null>;
  expire(key: string, seconds: number): Promise<number>;
}

/** The provider's daily counter resets at midnight UTC. */
export function emailBudgetKey(now: Date): string {
  return `email:sent:${now.toISOString().slice(0, 10)}`;
}

/** How many emails went out today, across the API and the worker. */
export async function emailsSentToday(counter: Counter, now = new Date()): Promise<number> {
  return Number((await counter.get(emailBudgetKey(now))) ?? 0);
}

/** Counts one email against today's budget. The key lives two days, then Redis drops it. */
export async function countEmailSent(counter: Counter, now = new Date()): Promise<number> {
  const key = emailBudgetKey(now);
  const n = await counter.incr(key);
  if (n === 1) await counter.expire(key, 2 * 24 * 3600);
  return n;
}

/**
 * Counts every email an adapter sends against the shared daily budget (free-tier limit). Emails a
 * person is waiting for, such as a verification link, are never held back; the worker defers its
 * own reminders and digests when the budget is spent.
 */
export function countingEmailAdapter(adapter: EmailAdapter, counter: Counter): EmailAdapter {
  return {
    name: adapter.name,
    idempotent: adapter.idempotent,
    async send(message) {
      const result = await adapter.send(message);
      await countEmailSent(counter).catch(() => undefined);
      return result;
    },
  };
}
