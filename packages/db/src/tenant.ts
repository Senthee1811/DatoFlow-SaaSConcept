import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * Tenant models and the column that holds the organization id.
 * A test reads schema.prisma and fails if a model with `organizationId` is missing here.
 */
export const TENANT_MODELS: Record<string, string> = {
  Organization: 'id',
  OrganizationMembership: 'organizationId',
  Invitation: 'organizationId',
  Pipeline: 'organizationId',
  PipelineStage: 'organizationId',
  AuditLog: 'organizationId',
};

export type DbContext = { mode: 'tenant'; organizationId: string } | { mode: 'system' };

export const dbContext = new AsyncLocalStorage<DbContext>();

export class TenantContextError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TenantContextError';
  }
}

type Args = Record<string, unknown>;

const WHERE_OPERATIONS = new Set([
  'findUnique',
  'findUniqueOrThrow',
  'findFirst',
  'findFirstOrThrow',
  'findMany',
  'count',
  'aggregate',
  'groupBy',
  'update',
  'updateMany',
  'updateManyAndReturn',
  'delete',
  'deleteMany',
  'upsert',
]);

function withOrg(data: unknown, column: string, organizationId: string): Args {
  const row = { ...((data ?? {}) as Args) };
  const given = row[column];
  if (given !== undefined && given !== organizationId) {
    throw new TenantContextError(`Refusing to write a row for another organization (${column})`);
  }
  // Organization.id is the tenant key itself, so creating one inside a tenant is never valid.
  row[column] = organizationId;
  return row;
}

/**
 * Adds the organization filter to one Prisma operation.
 * Reads get `where[column] = organizationId`; writes get the column forced to it.
 * Without a context the call fails closed.
 */
export function scopeArgs(
  model: string | undefined,
  operation: string,
  args: unknown,
  context: DbContext | undefined,
): unknown {
  const column = model ? TENANT_MODELS[model] : undefined;
  if (!column) return args;
  if (!context) {
    throw new TenantContextError(
      `${model}.${operation} ran outside withTenant() or withSystem(). Tenant tables need a context.`,
    );
  }
  if (context.mode === 'system') return args;

  const { organizationId } = context;
  const next: Args = { ...((args ?? {}) as Args) };

  if (WHERE_OPERATIONS.has(operation)) {
    next.where = { ...((next.where ?? {}) as Args), [column]: organizationId };
  }
  if (operation === 'create') {
    next.data = withOrg(next.data, column, organizationId);
  }
  if (operation === 'createMany' || operation === 'createManyAndReturn') {
    const rows = Array.isArray(next.data) ? next.data : [next.data];
    next.data = rows.map((row) => withOrg(row, column, organizationId));
  }
  if (operation === 'upsert') {
    next.create = withOrg(next.create, column, organizationId);
  }
  return next;
}
