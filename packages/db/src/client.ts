import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from './generated/prisma/client.js';
import { dbContext, scopeArgs } from './tenant.js';

/** Non-login role that tenant transactions switch to, so row-level security applies to them. */
export const TENANT_DB_ROLE = 'datoflow_app';

function extend(base: PrismaClient) {
  return base.$extends({
    name: 'tenant-scope',
    query: {
      $allModels: {
        $allOperations({ model, operation, args, query }) {
          return query(scopeArgs(model, operation, args, dbContext.getStore()) as typeof args);
        },
      },
    },
  });
}

type Scoped = ReturnType<typeof extend>;
/** A transaction client. Every query on a tenant table is filtered to the current organization. */
export type Tx = Parameters<Parameters<Scoped['$transaction']>[0]>[0];

export interface Db {
  /**
   * Runs `fn` in one transaction scoped to an organization.
   * The Prisma extension adds the organization filter, and the transaction runs as a role
   * that Postgres row-level security restricts to `app.organization_id`.
   */
  withTenant<T>(organizationId: string, fn: (tx: Tx) => Promise<T>): Promise<T>;
  /**
   * Runs `fn` in one transaction with no organization filter. Only for work that is not
   * tenant-scoped by nature: resolving a membership, creating an organization, background jobs.
   */
  withSystem<T>(fn: (tx: Tx) => Promise<T>): Promise<T>;
  /** Unscoped client for the auth provider, which only touches its own tables. */
  readonly raw: PrismaClient;
  ping(): Promise<void>;
  disconnect(): Promise<void>;
}

export function createDb(databaseUrl: string): Db {
  const raw = new PrismaClient({ adapter: new PrismaPg({ connectionString: databaseUrl }) });
  const scoped = extend(raw);

  return {
    raw,
    withTenant(organizationId, fn) {
      return scoped.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(`SET LOCAL ROLE ${TENANT_DB_ROLE}`);
        await tx.$executeRaw`SELECT set_config('app.organization_id', ${organizationId}, TRUE)`;
        // Prisma queries are lazy: they run when awaited. Awaiting inside run() keeps a callback
        // like `(tx) => tx.lead.findMany()` inside the context instead of after it.
        return dbContext.run({ mode: 'tenant', organizationId }, async () => await fn(tx));
      });
    },
    withSystem(fn) {
      return scoped.$transaction((tx) =>
        dbContext.run({ mode: 'system' }, async () => await fn(tx)),
      );
    },
    async ping() {
      await raw.$queryRaw`SELECT 1`;
    },
    async disconnect() {
      await raw.$disconnect();
    },
  };
}
