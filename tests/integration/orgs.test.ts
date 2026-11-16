import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  addMember,
  Client,
  createOrg,
  invite,
  setPlan,
  signUp,
  startApp,
  uniqueSlug,
  type TestApp,
} from './harness.js';

let app: TestApp;
beforeAll(async () => {
  app = await startApp();
});
afterAll(() => app.close());

describe('ORG-01 create an organization', () => {
  it('ORG-01: the creator becomes Owner and a 6-stage pipeline is created', async () => {
    const { client, userId } = await signUp(app, 'founder');
    const slug = uniqueSlug('northwind');
    const res = await client.post('/v1/orgs', {
      name: 'Northwind Leads',
      slug,
      timezone: 'Asia/Colombo',
      currency: 'LKR',
    });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      name: 'Northwind Leads',
      slug,
      timezone: 'Asia/Colombo',
      currency: 'LKR',
      role: 'OWNER',
      planCode: 'free',
    });

    const { rows: members } = await app.sql.query(
      'SELECT role, "userId" FROM "OrganizationMembership" WHERE "organizationId" = $1',
      [res.body.id],
    );
    expect(members).toEqual([{ role: 'OWNER', userId }]);

    const { rows: stages } = await app.sql.query(
      `SELECT s.name, s.kind, s."slaHours" FROM "PipelineStage" s JOIN "Pipeline" p ON p.id = s."pipelineId"
       WHERE p."organizationId" = $1 ORDER BY s."order"`,
      [res.body.id],
    );
    expect(stages.map((s) => s.kind)).toEqual(['OPEN', 'OPEN', 'OPEN', 'OPEN', 'WON', 'LOST']);
    expect(stages.every((s) => s.slaHours === 72)).toBe(true);
  });

  it('ORG-01: the slug is unique', async () => {
    const { client } = await signUp(app, 'slug');
    const slug = uniqueSlug('taken');
    const body = { name: 'First', slug, timezone: 'UTC', currency: 'USD' };
    expect((await client.post('/v1/orgs', body)).status).toBe(201);
    const second = await client.post('/v1/orgs', { ...body, name: 'Second' });
    expect(second.status).toBe(409);
    expect(second.body.code).toBe('SLUG_TAKEN');
  });

  it('ORG-01: invalid or unknown fields are a field-level 422', async () => {
    const { client } = await signUp(app, 'strict');
    const res = await client.post('/v1/orgs', {
      name: 'X',
      slug: 'Bad Slug',
      timezone: 'Nowhere',
      currency: 'usd',
      planCode: 'agency',
    });
    expect(res.status).toBe(422);
    expect(res.headers.get('content-type')).toContain('application/problem+json');
    const paths = res.body.errors.map((e: { path: string }) => e.path);
    expect(paths).toEqual(
      expect.arrayContaining(['body.name', 'body.slug', 'body.timezone', 'body']),
    );
  });
});

describe('ORG-02 many organizations and the active one', () => {
  it('ORG-02: a member of two organizations lists both and switches the active one', async () => {
    const { client } = await signUp(app, 'multi');
    const a = await createOrg(client, 'alpha');
    const b = await createOrg(client, 'beta');
    const list = await client.get('/v1/orgs');
    expect(list.body.items.map((o: { id: string }) => o.id).sort()).toEqual([a.id, b.id].sort());

    expect(
      (await client.post('/v1/auth/organization/set-active', { organizationId: b.id })).status,
    ).toBe(200);
    expect((await client.get('/v1/me')).body.activeOrganizationId).toBe(b.id);
    expect(
      (await client.post('/v1/auth/organization/set-active', { organizationId: a.id })).status,
    ).toBe(200);
    expect((await client.get('/v1/me')).body.activeOrganizationId).toBe(a.id);
  });

  it('ORG-02: a request for an org without membership returns 404', async () => {
    const owner = await signUp(app, 'owner404');
    const org = await createOrg(owner.client, 'private');
    const stranger = await signUp(app, 'stranger');
    const res = await stranger.client.get(`/v1/orgs/${org.id}`);
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('NOT_FOUND');
    expect((await stranger.client.get('/v1/orgs/not-a-real-id')).status).toBe(404);
    expect((await stranger.client.get(`/v1/orgs/${org.id}/members`)).status).toBe(404);
    expect(
      (await stranger.client.post('/v1/auth/organization/set-active', { organizationId: org.id }))
        .status,
    ).not.toBe(200);
    expect((await stranger.client.get('/v1/me')).body.activeOrganizationId).toBeNull();
  });

  it('ORG-02: Better Auth organization endpoints other than set-active are closed', async () => {
    const { client } = await signUp(app, 'closed');
    const res = await client.post('/v1/auth/organization/create', {
      name: 'Sneaky',
      slug: uniqueSlug('sneaky'),
    });
    expect(res.status).toBe(404);
  });
});

describe('ORG-03 invitations, roles and members', () => {
  it('ORG-03: the token is stored only as a hash, expires in 7 days and is single-use', async () => {
    const owner = await signUp(app, 'inviter');
    const org = await createOrg(owner.client, 'tokens');
    const invitee = await signUp(app, 'invitee');
    const { invitation, token } = await invite(app, owner.client, org.id, invitee.email, 'REP');

    const { rows } = await app.sql.query(
      `SELECT "tokenHash", EXTRACT(EPOCH FROM ("expiresAt" - "createdAt")) AS seconds FROM "Invitation" WHERE id = $1`,
      [invitation.id],
    );
    expect(rows[0].tokenHash).toMatch(/^[0-9a-f]{64}$/);
    expect(rows[0].tokenHash).not.toContain(token);
    expect(Number(rows[0].seconds)).toBeCloseTo(7 * 24 * 3600, -1);
    expect(JSON.stringify(invitation)).not.toMatch(/token/i);

    expect((await invitee.client.post(`/v1/invitations/${token}/accept`)).status).toBe(201);
    const again = await invitee.client.post(`/v1/invitations/${token}/accept`);
    expect(again.status).toBe(409);
    expect(again.body).toMatchObject({ code: 'INVITATION_INVALID', reason: 'USED' });
  });

  it('ORG-03: the invitation must match the invitee email', async () => {
    const owner = await signUp(app, 'mismatch-owner');
    const org = await createOrg(owner.client, 'mismatch');
    const intended = await signUp(app, 'intended');
    const other = await signUp(app, 'other');
    const { token } = await invite(app, owner.client, org.id, intended.email, 'REP');

    const preview = await other.client.get(`/v1/invitations/${token}`);
    expect(preview.body.problem).toBe('EMAIL_MISMATCH');
    const res = await other.client.post(`/v1/invitations/${token}/accept`);
    expect(res.body).toMatchObject({ code: 'INVITATION_INVALID', reason: 'EMAIL_MISMATCH' });
    expect((await other.client.get(`/v1/orgs/${org.id}`)).status).toBe(404);
  });

  it('ORG-03: an expired invitation cannot be accepted', async () => {
    const owner = await signUp(app, 'expired-owner');
    const org = await createOrg(owner.client, 'expired');
    const invitee = await signUp(app, 'late');
    const { invitation, token } = await invite(app, owner.client, org.id, invitee.email, 'REP');
    await app.sql.query(
      `UPDATE "Invitation" SET "expiresAt" = now() - interval '1 minute' WHERE id = $1`,
      [invitation.id],
    );
    const res = await invitee.client.post(`/v1/invitations/${token}/accept`);
    expect(res.body).toMatchObject({ code: 'INVITATION_INVALID', reason: 'EXPIRED' });
  });

  it('ORG-03: resend issues a new link and revokes the old one; revoke closes it', async () => {
    const owner = await signUp(app, 'resend-owner');
    const org = await createOrg(owner.client, 'resend');
    const invitee = await signUp(app, 'resent');
    const { invitation, token: first } = await invite(
      app,
      owner.client,
      org.id,
      invitee.email,
      'MANAGER',
    );

    expect(
      (await owner.client.post(`/v1/orgs/${org.id}/invitations/${invitation.id}/resend`)).status,
    ).toBe(201);
    const second = app.outbox.link(invitee.email, /invited you/).split('/invite/')[1]!;
    expect(second).not.toBe(first);
    expect((await invitee.client.get(`/v1/invitations/${first}`)).status).toBe(404);

    const revoked = await owner.client.post(
      `/v1/orgs/${org.id}/invitations/${invitation.id}/revoke`,
    );
    expect(revoked.body.status).toBe('REVOKED');
    expect((await invitee.client.post(`/v1/invitations/${second}/accept`)).body.reason).toBe(
      'REVOKED',
    );
  });

  it('ORG-03: Admins cannot grant Owner; Managers and Reps cannot invite', async () => {
    const owner = await signUp(app, 'grant-owner');
    const org = await createOrg(owner.client, 'grant');
    await setPlan(app, org.id, 'starter');
    const admin = await addMember(app, owner.client, org.id, 'ADMIN');
    const manager = await addMember(app, owner.client, org.id, 'MANAGER');

    expect(
      (
        await admin.client.post(`/v1/orgs/${org.id}/invitations`, {
          email: 'x@example.test',
          role: 'OWNER',
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await admin.client.post(`/v1/orgs/${org.id}/invitations`, {
          email: 'y@example.test',
          role: 'REP',
        })
      ).status,
    ).toBe(201);
    expect(
      (
        await manager.client.post(`/v1/orgs/${org.id}/invitations`, {
          email: 'z@example.test',
          role: 'REP',
        })
      ).status,
    ).toBe(403);
  });

  it('ORG-03: the last Owner cannot be removed or demoted', async () => {
    const owner = await signUp(app, 'last-owner');
    const org = await createOrg(owner.client, 'lastowner');
    const members = await owner.client.get(`/v1/orgs/${org.id}/members`);
    const self = members.body.items[0];

    const demote = await owner.client.patch(`/v1/orgs/${org.id}/members/${self.id}`, {
      role: 'ADMIN',
    });
    expect(demote.status).toBe(409);
    expect(demote.body.code).toBe('LAST_OWNER');
    expect((await owner.client.delete(`/v1/orgs/${org.id}/members/${self.id}`)).body.code).toBe(
      'LAST_OWNER',
    );

    const second = await addMember(app, owner.client, org.id, 'ADMIN');
    expect(
      (
        await owner.client.patch(`/v1/orgs/${org.id}/members/${second.membershipId}`, {
          role: 'OWNER',
        })
      ).status,
    ).toBe(200);
    expect(
      (await owner.client.patch(`/v1/orgs/${org.id}/members/${self.id}`, { role: 'ADMIN' })).status,
    ).toBe(200);
  });

  it('ORG-03: Admins cannot change or remove an Owner; they can manage other roles', async () => {
    const owner = await signUp(app, 'admin-limits');
    const org = await createOrg(owner.client, 'adminlimits');
    await setPlan(app, org.id, 'starter');
    const admin = await addMember(app, owner.client, org.id, 'ADMIN');
    const rep = await addMember(app, owner.client, org.id, 'REP');
    const ownerRow = (await owner.client.get(`/v1/orgs/${org.id}/members`)).body.items.find(
      (m: { role: string }) => m.role === 'OWNER',
    );

    expect(
      (await admin.client.patch(`/v1/orgs/${org.id}/members/${ownerRow.id}`, { role: 'REP' }))
        .status,
    ).toBe(403);
    expect((await admin.client.delete(`/v1/orgs/${org.id}/members/${ownerRow.id}`)).status).toBe(
      403,
    );
    expect(
      (
        await admin.client.patch(`/v1/orgs/${org.id}/members/${rep.membershipId}`, {
          role: 'OWNER',
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await admin.client.patch(`/v1/orgs/${org.id}/members/${rep.membershipId}`, {
          role: 'MANAGER',
        })
      ).body.role,
    ).toBe('MANAGER');
    expect(
      (await admin.client.delete(`/v1/orgs/${org.id}/members/${rep.membershipId}`)).status,
    ).toBe(204);
    expect((await rep.client.get(`/v1/orgs/${org.id}`)).status).toBe(404);
  });

  it('ORG-03: concurrent demotions of the only two Owners leave one Owner', async () => {
    const owner = await signUp(app, 'race-a');
    const org = await createOrg(owner.client, 'race');
    const other = await addMember(app, owner.client, org.id, 'ADMIN', 'race-b');
    await owner.client.patch(`/v1/orgs/${org.id}/members/${other.membershipId}`, { role: 'OWNER' });
    const ownerRow = (await owner.client.get(`/v1/orgs/${org.id}/members`)).body.items.find(
      (m: { userId: string }) => m.userId === owner.userId,
    );
    const results = await Promise.all([
      owner.client.patch(`/v1/orgs/${org.id}/members/${other.membershipId}`, { role: 'REP' }),
      other.client.patch(`/v1/orgs/${org.id}/members/${ownerRow.id}`, { role: 'REP' }),
    ]);
    // The loser gets 409 LAST_OWNER, or 403 if the winner already demoted it. Either way one Owner stays.
    const statuses = results.map((r) => r.status).sort();
    expect(statuses[0]).toBe(200);
    expect([403, 409]).toContain(statuses[1]);
    const { rows } = await app.sql.query(
      `SELECT count(*)::int AS n FROM "OrganizationMembership" WHERE "organizationId" = $1 AND role = 'OWNER'`,
      [org.id],
    );
    expect(rows[0].n).toBe(1);
  });

  it('UF-4: a full plan returns 402 naming the users limit', async () => {
    const owner = await signUp(app, 'seats');
    const org = await createOrg(owner.client, 'seats');
    // Free plan: 2 users. The Owner plus one open invitation fills it.
    expect(
      (
        await owner.client.post(`/v1/orgs/${org.id}/invitations`, {
          email: 'one@example.test',
          role: 'REP',
        })
      ).status,
    ).toBe(201);
    const full = await owner.client.post(`/v1/orgs/${org.id}/invitations`, {
      email: 'two@example.test',
      role: 'REP',
    });
    expect(full.status).toBe(402);
    expect(full.body).toMatchObject({ code: 'PLAN_LIMIT_REACHED', limit: 'users' });
  });

  it('UF-4: accepting adds the member, audit-logs it and emails the inviter', async () => {
    const owner = await signUp(app, 'uf4-owner', 'Ruwani Owner');
    const org = await createOrg(owner.client, 'uf4');
    const rep = await signUp(app, 'uf4-rep', 'Kasun Rep');
    const { token } = await invite(app, owner.client, org.id, rep.email, 'REP');
    const accepted = await rep.client.post(`/v1/invitations/${token}/accept`);
    expect(accepted.body).toMatchObject({ organizationId: org.id, role: 'REP' });
    expect(app.outbox.last(owner.email, /joined/).text).toContain('Kasun Rep');
    expect((await rep.client.get(`/v1/orgs/${org.id}`)).body.role).toBe('REP');
  });
});

describe('AUD-01 role and invitation events', () => {
  it('AUD-01: invitations and role changes are audited; Managers cannot read the log', async () => {
    const owner = await signUp(app, 'audit-owner');
    const org = await createOrg(owner.client, 'audit');
    const manager = await addMember(app, owner.client, org.id, 'MANAGER');
    await owner.client.patch(`/v1/orgs/${org.id}/members/${manager.membershipId}`, { role: 'REP' });

    const log = await owner.client.get(`/v1/orgs/${org.id}/audit-logs?limit=100`);
    expect(log.status).toBe(200);
    const actions = log.body.items.map((e: { action: string }) => e.action);
    expect(actions).toEqual(
      expect.arrayContaining([
        'org.created',
        'invitation.created',
        'invitation.accepted',
        'member.role_changed',
      ]),
    );
    const change = log.body.items.find(
      (e: { action: string }) => e.action === 'member.role_changed',
    );
    expect(change.metadata).toMatchObject({ from: 'MANAGER', to: 'REP' });
    expect(JSON.stringify(log.body)).not.toMatch(/tokenHash|password/);

    expect((await manager.client.get(`/v1/orgs/${org.id}/audit-logs`)).status).toBe(403);
  });

  it('AUD-01: the audit log is append-only at the database', async () => {
    const owner = await signUp(app, 'append');
    const org = await createOrg(owner.client, 'append');
    await expect(
      app.sql.query(`UPDATE "AuditLog" SET action = 'x' WHERE "organizationId" = $1`, [org.id]),
    ).rejects.toThrow(/append-only/);
    await expect(
      app.sql.query(`DELETE FROM "AuditLog" WHERE "organizationId" = $1`, [org.id]),
    ).rejects.toThrow(/append-only/);
  });

  it('pagination: the audit log pages with a cursor', async () => {
    const owner = await signUp(app, 'pages');
    const org = await createOrg(owner.client, 'pages');
    for (let i = 0; i < 3; i++)
      await owner.client.patch(`/v1/orgs/${org.id}`, { name: `Pages ${i}` });
    const first = await owner.client.get(`/v1/orgs/${org.id}/audit-logs?limit=2`);
    expect(first.body.items).toHaveLength(2);
    const second = await owner.client.get(
      `/v1/orgs/${org.id}/audit-logs?limit=2&cursor=${first.body.nextCursor}`,
    );
    expect(second.body.items).toHaveLength(2);
    const ids = [...first.body.items, ...second.body.items].map((e: { id: string }) => e.id);
    expect(new Set(ids).size).toBe(4);
    expect((await owner.client.get(`/v1/orgs/${org.id}/audit-logs?limit=101`)).status).toBe(422);
  });
});

describe('NFR-SEC-01 row-level security', () => {
  it('NFR-SEC-01: the tenant role sees only its own organization, even with no filter', async () => {
    const a = await signUp(app, 'rls-a');
    const orgA = await createOrg(a.client, 'rlsa');
    const b = await signUp(app, 'rls-b');
    const orgB = await createOrg(b.client, 'rlsb');
    const client = await app.sql.connect();
    try {
      await client.query('BEGIN');
      await client.query('SET LOCAL ROLE datoflow_app');
      await client.query(`SELECT set_config('app.organization_id', $1, true)`, [orgA.id]);
      const orgs = await client.query('SELECT id FROM "Organization"');
      expect(orgs.rows.map((r) => r.id)).toEqual([orgA.id]);
      const logs = await client.query('SELECT DISTINCT "organizationId" FROM "AuditLog"');
      expect(logs.rows.map((r) => r.organizationId)).toEqual([orgA.id]);
      await expect(
        client.query(
          `INSERT INTO "Pipeline" (id, "organizationId", name, "updatedAt") VALUES ('p-x', $1, 'Stolen', now())`,
          [orgB.id],
        ),
      ).rejects.toThrow(/row-level security/);
      await client.query('ROLLBACK');

      await client.query('BEGIN');
      await client.query('SET LOCAL ROLE datoflow_app');
      expect((await client.query('SELECT id FROM "Organization"')).rows).toEqual([]);
      await client.query('ROLLBACK');
    } finally {
      client.release();
    }
  });
});

describe('API conventions', () => {
  it('Idempotency-Key replays the first response and rejects a different body', async () => {
    const { client } = await signUp(app, 'idem');
    const slug = uniqueSlug('idem');
    const body = { name: 'Idem Agency', slug, timezone: 'UTC', currency: 'USD' };
    const headers = { 'idempotency-key': 'create-org-0001' };
    const first = await client.post('/v1/orgs', body, headers);
    const second = await client.post('/v1/orgs', body, headers);
    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect(second.headers.get('idempotent-replayed')).toBe('true');
    expect(second.body.id).toBe(first.body.id);
    const { rows } = await app.sql.query(
      'SELECT count(*)::int AS n FROM "Organization" WHERE slug = $1',
      [slug],
    );
    expect(rows[0].n).toBe(1);
    const changed = await client.post('/v1/orgs', { ...body, name: 'Other' }, headers);
    expect(changed.status).toBe(422);
    expect(changed.body.code).toBe('IDEMPOTENCY_KEY_REUSED');
  });

  it('X-Request-Id is echoed back, and generated when absent', async () => {
    const client = new Client(app);
    const given = await client.get('/health/live', { 'x-request-id': 'trace-abc-123' });
    expect(given.headers.get('x-request-id')).toBe('trace-abc-123');
    const generated = await client.get('/v1/me');
    expect(generated.headers.get('x-request-id')).toMatch(/^[0-9a-f-]{36}$/);
    expect(generated.body.requestId).toBe(generated.headers.get('x-request-id'));
  });

  it('NFR-OBS-01: health endpoints report the database and Redis', async () => {
    const client = new Client(app);
    expect((await client.get('/health/live')).body).toEqual({ status: 'ok' });
    expect((await client.get('/health/ready')).body).toEqual({
      status: 'ok',
      checks: { database: 'ok', redis: 'ok' },
    });
  });

  it('NFR-SEC-03: security headers are set', async () => {
    const res = await new Client(app).get('/health/live');
    expect(res.headers.get('strict-transport-security')).toContain('max-age=');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('content-security-policy')).toContain("default-src 'none'");
  });
});

describe('NFR-SEC-04 rate limits', () => {
  let limited: TestApp;
  beforeAll(async () => {
    // Its own Redis database, so these counters do not touch the other tests.
    limited = await startApp({
      REDIS_URL: `${app.env.REDIS_URL}/3`,
      RATE_LIMIT_AUTH_PER_MIN: '5',
      RATE_LIMIT_API_PER_MIN: '300',
    });
    await limited.sql.query('SELECT 1');
  });
  afterAll(() => limited.close());

  it('NFR-SEC-04: auth allows 5 attempts per minute per IP, then 429', async () => {
    const client = new Client(limited);
    const statuses: number[] = [];
    for (let i = 0; i < 6; i++) {
      statuses.push(
        (
          await client.post('/v1/auth/sign-in/email', {
            email: 'nobody@example.test',
            password: 'wrong-password',
          })
        ).status,
      );
    }
    expect(statuses.slice(0, 5).every((s) => s === 401)).toBe(true);
    const last = await client.post('/v1/auth/sign-in/email', {
      email: 'nobody@example.test',
      password: 'x',
    });
    expect(last.status).toBe(429);
    expect(last.body.code).toBe('RATE_LIMITED');
    expect(Number(last.headers.get('retry-after'))).toBeGreaterThan(0);
    // Reading the session, signing out and switching workspace are not limited.
    expect((await client.get('/v1/auth/get-session')).status).toBe(200);
    expect((await client.post('/v1/auth/sign-out')).status).not.toBe(429);
    expect(
      (await client.post('/v1/auth/organization/set-active', { organizationId: null })).status,
    ).not.toBe(429);
  });
});
