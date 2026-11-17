/** Prisma's code for a transaction that lost a write conflict or a deadlock. */
const CONFLICT = 'P2034';

/**
 * Runs a transaction again when Postgres aborted it for a deadlock or a write conflict. Use it
 * for broad writes that may cross background work, such as deleting the sample data while sample
 * workflows run. The whole transaction is retried, so it must be safe to run twice.
 */
export async function retryOnConflict<T>(fn: () => Promise<T>, attempts = 3): Promise<T> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await fn();
    } catch (err) {
      const code = (err as { code?: unknown }).code;
      if (code !== CONFLICT || attempt >= attempts) throw err;
      await new Promise((r) => setTimeout(r, 50 * attempt));
    }
  }
}
