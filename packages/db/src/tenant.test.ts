import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { TENANT_MODELS, TenantContextError, scopeArgs, type DbContext } from './tenant.js';

const prismaDir = join(import.meta.dirname, '..', 'prisma');
const schema = readFileSync(join(prismaDir, 'schema.prisma'), 'utf8');
const models = [...schema.matchAll(/^model (\w+) \{([\s\S]*?)^\}/gm)].map((m) => ({
  name: m[1]!,
  body: m[2]!,
}));
const migrations = readdirSync(join(prismaDir, 'migrations'), { withFileTypes: true })
  .filter((d) => d.isDirectory())
  .map((d) => readFileSync(join(prismaDir, 'migrations', d.name, 'migration.sql'), 'utf8'))
  .join('\n');

const tenant: DbContext = { mode: 'tenant', organizationId: 'org_a' };

describe('tenancy (NFR-SEC-01)', () => {
  it('every model with organizationId is a tenant model, and Organization is one', () => {
    const withColumn = models.filter((m) => /^\s+organizationId\s+String\b/m.test(m.body));
    expect(withColumn.map((m) => m.name).sort()).toEqual(
      Object.keys(TENANT_MODELS)
        .filter((m) => m !== 'Organization')
        .sort(),
    );
    expect(TENANT_MODELS.Organization).toBe('id');
  });

  it('organizationId is NOT NULL and indexed on every tenant table', () => {
    for (const m of models.filter((x) => x.name in TENANT_MODELS && x.name !== 'Organization')) {
      expect(m.body, m.name).toMatch(/^\s+organizationId\s+String\s*$/m);
      expect(m.body, m.name).toMatch(/@@(index|unique)\(\[[^\]]*organizationId/);
    }
  });

  it('every tenant table has row-level security and a policy in a migration', () => {
    for (const name of Object.keys(TENANT_MODELS)) {
      expect(migrations, name).toContain(`ALTER TABLE "${name}" ENABLE ROW LEVEL SECURITY`);
      expect(migrations, name).toMatch(new RegExp(`CREATE POLICY \\w+ ON "${name}"`));
    }
  });

  it('adds the organization filter to reads', () => {
    expect(scopeArgs('Invitation', 'findMany', { where: { email: 'a@b.co' } }, tenant)).toEqual({
      where: { email: 'a@b.co', organizationId: 'org_a' },
    });
    expect(scopeArgs('Invitation', 'count', undefined, tenant)).toEqual({
      where: { organizationId: 'org_a' },
    });
    expect(scopeArgs('Organization', 'findUnique', { where: { id: 'org_b' } }, tenant)).toEqual({
      where: { id: 'org_a' },
    });
  });

  it('a caller cannot widen the filter', () => {
    const args = { where: { organizationId: 'org_b', id: 'x' } };
    expect(scopeArgs('Pipeline', 'update', args, tenant)).toEqual({
      where: { organizationId: 'org_a', id: 'x' },
    });
    expect(scopeArgs('Pipeline', 'deleteMany', args, tenant)).toEqual({
      where: { organizationId: 'org_a', id: 'x' },
    });
  });

  it('forces the organization on writes and refuses another one', () => {
    expect(scopeArgs('Pipeline', 'create', { data: { name: 'P' } }, tenant)).toEqual({
      data: { name: 'P', organizationId: 'org_a' },
    });
    expect(
      scopeArgs(
        'PipelineStage',
        'createMany',
        { data: [{ name: 'New' }, { name: 'Won' }] },
        tenant,
      ),
    ).toEqual({
      data: [
        { name: 'New', organizationId: 'org_a' },
        { name: 'Won', organizationId: 'org_a' },
      ],
    });
    expect(() =>
      scopeArgs('Pipeline', 'create', { data: { name: 'P', organizationId: 'org_b' } }, tenant),
    ).toThrow(TenantContextError);
    expect(
      scopeArgs(
        'Pipeline',
        'upsert',
        { where: { id: 'x' }, create: { name: 'P' }, update: {} },
        tenant,
      ),
    ).toEqual({
      where: { id: 'x', organizationId: 'org_a' },
      create: { name: 'P', organizationId: 'org_a' },
      update: {},
    });
  });

  it('fails closed when a tenant table is queried without a context', () => {
    expect(() => scopeArgs('AuditLog', 'findMany', {}, undefined)).toThrow(/outside withTenant/);
  });

  it('leaves system work and non-tenant tables alone', () => {
    const args = { where: { email: 'a@b.co' } };
    expect(scopeArgs('Invitation', 'findMany', args, { mode: 'system' })).toBe(args);
    expect(scopeArgs('User', 'findMany', args, undefined)).toBe(args);
    expect(scopeArgs(undefined, '$queryRaw', args, undefined)).toBe(args);
  });
});
