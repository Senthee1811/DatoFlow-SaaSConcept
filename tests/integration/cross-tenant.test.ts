/**
 * NFR-SEC-01 cross-tenant suite, generated from the OpenAPI document.
 *
 * - Every route with `{orgId}` is called by the Owner of organization A with organization B's id,
 *   for every method, and must return 404.
 * - Every route with another id parameter must have a case below that uses organization A's
 *   path with an id from organization B, and must also return 404.
 * - Every route without `{orgId}` must have a case below that shows why it cannot leak.
 * A route with no applicable case fails the suite, so new routes cannot ship untested.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  addMember,
  Client,
  createOrg,
  invite,
  setPlan,
  signUp,
  startApp,
  type TestApp,
} from './harness.js';

type Op = { method: string; path: string };

interface World {
  a: { owner: Client; orgId: string; userId: string };
  b: {
    owner: Client;
    orgId: string;
    name: string;
    memberId: string;
    memberUserId: string;
    invitationId: string;
    invitationToken: string;
    leadId: string;
    leadName: string;
    pipelineId: string;
    stageId: string;
    taskId: string;
    notificationId: string;
  };
}

let app: TestApp;
let world: World;
let operations: Op[];

function fill(path: string, params: Record<string, string>) {
  return path.replace(/\{(\w+)\}/g, (_, name: string) => {
    const value = params[name];
    if (!value) throw new Error(`No value for {${name}} in ${path}`);
    return value;
  });
}

async function call(client: Client, op: Op, params: Record<string, string>) {
  const url = fill(op.path, params);
  const body = op.method === 'GET' || op.method === 'DELETE' ? undefined : {};
  return client.request(op.method, url, body);
}

async function leadB(w: World) {
  const { rows } = await app.sql.query(
    'SELECT name, "stageId", "archivedAt" FROM "Lead" WHERE id = $1',
    [w.b.leadId],
  );
  return rows[0] as { name: string; stageId: string; archivedAt: Date | null };
}

/** A's path with B's lead: 404, and B's lead is unchanged. */
const leadCase = (body?: unknown) => async (w: World, op: Op) => {
  const res = await w.a.owner.request(
    op.method,
    fill(op.path, { orgId: w.a.orgId, leadId: w.b.leadId }),
    body,
  );
  expect(res.status, `${op.method} ${op.path}`).toBe(404);
  expect(await leadB(w)).toMatchObject({ name: w.b.leadName, archivedAt: null });
};

/** Cases for routes with an id parameter other than orgId: A's path, B's id. */
const NESTED: Record<string, (w: World, op: Op) => Promise<void>> = {
  'GET /v1/orgs/{orgId}/leads/{leadId}': leadCase(),
  'PATCH /v1/orgs/{orgId}/leads/{leadId}': leadCase({ name: 'Hijacked' }),
  'POST /v1/orgs/{orgId}/leads/{leadId}/archive': leadCase({}),
  'POST /v1/orgs/{orgId}/leads/{leadId}/restore': leadCase({}),
  'GET /v1/orgs/{orgId}/leads/{leadId}/activities': leadCase(),
  'POST /v1/orgs/{orgId}/leads/{leadId}/activities': async (w, op) => {
    await leadCase({ type: 'NOTE', text: 'Planted note' })(w, op);
    const { rows } = await app.sql.query(
      `SELECT count(*)::int AS n FROM "LeadActivity" WHERE "leadId" = $1 AND type = 'NOTE'`,
      [w.b.leadId],
    );
    expect(rows[0].n).toBe(0);
  },
  'PATCH /v1/orgs/{orgId}/tasks/{taskId}': async (w, op) => {
    const res = await w.a.owner.request(
      op.method,
      fill(op.path, { orgId: w.a.orgId, taskId: w.b.taskId }),
      { status: 'DONE', title: 'Hijacked' },
    );
    expect(res.status).toBe(404);
    const { rows } = await app.sql.query('SELECT status, title FROM "Task" WHERE id = $1', [
      w.b.taskId,
    ]);
    expect(rows[0]).toEqual({ status: 'OPEN', title: 'Tenant B step' });
  },
  'POST /v1/orgs/{orgId}/notifications/{notificationId}/read': async (w, op) => {
    const res = await w.a.owner.post(
      fill(op.path, { orgId: w.a.orgId, notificationId: w.b.notificationId }),
    );
    expect(res.status).toBe(404);
    const { rows } = await app.sql.query('SELECT "readAt" FROM "Notification" WHERE id = $1', [
      w.b.notificationId,
    ]);
    expect(rows[0].readAt).toBeNull();
  },
  'PATCH /v1/orgs/{orgId}/pipelines/{pipelineId}': async (w, op) => {
    const res = await w.a.owner.request(
      op.method,
      fill(op.path, { orgId: w.a.orgId, pipelineId: w.b.pipelineId }),
      { name: 'Hijacked' },
    );
    expect(res.status).toBe(404);
    const { rows } = await app.sql.query('SELECT name FROM "Pipeline" WHERE id = $1', [
      w.b.pipelineId,
    ]);
    expect(rows[0].name).toBe('Sales pipeline');
  },
  'PATCH /v1/orgs/{orgId}/pipelines/{pipelineId}/stages': async (w, op) => {
    const res = await w.a.owner.request(
      op.method,
      fill(op.path, { orgId: w.a.orgId, pipelineId: w.b.pipelineId }),
      {
        stages: [
          { name: 'Only', slaHours: 1, kind: 'OPEN' },
          { name: 'Won', slaHours: 1, kind: 'WON' },
          { name: 'Lost', slaHours: 1, kind: 'LOST' },
        ],
      },
    );
    expect(res.status).toBe(404);
    const { rows } = await app.sql.query(
      'SELECT count(*)::int AS n FROM "PipelineStage" WHERE "pipelineId" = $1',
      [w.b.pipelineId],
    );
    expect(rows[0].n).toBe(6);
  },
  'PATCH /v1/orgs/{orgId}/members/{memberId}': async (w, op) => {
    const res = await w.a.owner.request(
      op.method,
      fill(op.path, { orgId: w.a.orgId, memberId: w.b.memberId }),
      { role: 'OWNER' },
    );
    expect(res.status).toBe(404);
    const { rows } = await app.sql.query(
      'SELECT role FROM "OrganizationMembership" WHERE id = $1',
      [w.b.memberId],
    );
    expect(rows[0].role).toBe('REP');
  },
  'DELETE /v1/orgs/{orgId}/members/{memberId}': async (w, op) => {
    const res = await w.a.owner.request(
      op.method,
      fill(op.path, { orgId: w.a.orgId, memberId: w.b.memberId }),
    );
    expect(res.status).toBe(404);
    const { rows } = await app.sql.query('SELECT id FROM "OrganizationMembership" WHERE id = $1', [
      w.b.memberId,
    ]);
    expect(rows).toHaveLength(1);
  },
  'POST /v1/orgs/{orgId}/invitations/{invitationId}/resend': async (w, op) => {
    const res = await w.a.owner.post(
      fill(op.path, { orgId: w.a.orgId, invitationId: w.b.invitationId }),
    );
    expect(res.status).toBe(404);
  },
  'POST /v1/orgs/{orgId}/invitations/{invitationId}/revoke': async (w, op) => {
    const res = await w.a.owner.post(
      fill(op.path, { orgId: w.a.orgId, invitationId: w.b.invitationId }),
    );
    expect(res.status).toBe(404);
    const { rows } = await app.sql.query('SELECT status FROM "Invitation" WHERE id = $1', [
      w.b.invitationId,
    ]);
    expect(rows[0].status).toBe('PENDING');
  },
};

/** Cases for routes without {orgId}. Each shows why the route cannot reach another tenant. */
const UNSCOPED: Record<string, (w: World, op: Op) => Promise<void>> = {
  'GET /v1/me': async (w) => {
    const res = await w.a.owner.get('/v1/me');
    expect(res.body.id).toBe(w.a.userId);
  },
  'GET /v1/orgs': async (w) => {
    const res = await w.a.owner.get('/v1/orgs');
    const ids = res.body.items.map((o: { id: string }) => o.id);
    expect(ids).toContain(w.a.orgId);
    expect(ids).not.toContain(w.b.orgId);
  },
  'POST /v1/orgs': async (w) => {
    // Creating an organization cannot name an existing one: unknown fields such as `id` are refused.
    const res = await w.a.owner.post('/v1/orgs', {
      id: w.b.orgId,
      name: 'Hijack',
      slug: 'hijack-x',
      timezone: 'UTC',
      currency: 'USD',
    });
    expect(res.status).toBe(422);
  },
  // Invitation tokens are bearer secrets held by the invitee, not tenant ids.
  'GET /v1/invitations/{token}': async (w) => {
    const guessed = await w.a.owner.get(`/v1/invitations/${'A'.repeat(43)}`);
    expect(guessed.status).toBe(404);
    expect((await w.a.owner.get('/v1/invitations/not-a-token')).status).toBe(404);
  },
  'POST /v1/invitations/{token}/accept': async (w) => {
    // Even holding organization B's token, A's owner is not the invitee and cannot join.
    const res = await w.a.owner.post(`/v1/invitations/${w.b.invitationToken}/accept`);
    expect(res.status).toBe(409);
    expect(res.body.reason).toBe('EMAIL_MISMATCH');
    expect((await w.a.owner.get(`/v1/orgs/${w.b.orgId}`)).status).toBe(404);
  },
};

beforeAll(async () => {
  app = await startApp();
  const ownerA = await signUp(app, 'tenant-a');
  const orgA = await createOrg(ownerA.client, 'tenanta');
  const ownerB = await signUp(app, 'tenant-b');
  const orgB = await createOrg(ownerB.client, 'tenantb');
  await setPlan(app, orgB.id, 'starter');
  const memberB = await addMember(app, ownerB.client, orgB.id, 'REP', 'tenant-b-rep');
  const pending = await invite(app, ownerB.client, orgB.id, 'pending-b@example.test', 'MANAGER');
  const lead = await ownerB.client.post(`/v1/orgs/${orgB.id}/leads`, {
    name: 'Tenant B Lead',
    email: 'b-lead@example.test',
  });
  if (lead.status !== 201)
    throw new Error(`lead create failed: ${lead.status} ${JSON.stringify(lead.body)}`);
  const pipelines = await ownerB.client.get(`/v1/orgs/${orgB.id}/pipelines`);
  const task = await ownerB.client.post(`/v1/orgs/${orgB.id}/tasks`, {
    leadId: lead.body.id,
    title: 'Tenant B step',
    type: 'CALL',
    dueAt: new Date(Date.now() + 86_400_000).toISOString(),
  });
  if (task.status !== 201) throw new Error(`task create failed: ${task.status}`);
  // B's owner was notified when B's rep joined (NOT-01).
  const notifications = await ownerB.client.get(`/v1/orgs/${orgB.id}/notifications`);
  world = {
    a: { owner: ownerA.client, orgId: orgA.id, userId: ownerA.userId },
    b: {
      owner: ownerB.client,
      orgId: orgB.id,
      name: orgB.name,
      memberId: memberB.membershipId,
      memberUserId: memberB.userId,
      invitationId: pending.invitation.id,
      invitationToken: pending.token,
      leadId: lead.body.id,
      leadName: 'Tenant B Lead',
      pipelineId: pipelines.body.items[0].id,
      stageId: pipelines.body.items[0].stages[0].id,
      taskId: task.body.id,
      notificationId: notifications.body.items[0].id,
    },
  };
  const doc = (await new Client(app).get('/v1/openapi.json')).body as {
    paths: Record<string, Record<string, unknown>>;
  };
  operations = Object.entries(doc.paths).flatMap(([path, methods]) =>
    Object.keys(methods).map((method) => ({ method: method.toUpperCase(), path })),
  );
});
afterAll(() => app.close());

describe('NFR-SEC-01 cross-tenant suite', () => {
  it('NFR-SEC-01: every route in the OpenAPI document has a cross-tenant case', () => {
    expect(operations.length).toBeGreaterThan(10);
    const missing = operations
      .map((op) => `${op.method} ${op.path}`)
      .filter((key) => {
        const params = [...key.matchAll(/\{(\w+)\}/g)].map((m) => m[1]);
        if (!params.includes('orgId')) return !(key in UNSCOPED);
        const nested = params.filter((p) => p !== 'orgId');
        return nested.length > 0 && !(key in NESTED);
      });
    expect(missing, 'Add a case for these routes').toEqual([]);
    const stale = [...Object.keys(NESTED), ...Object.keys(UNSCOPED)].filter(
      (key) => !operations.some((op) => `${op.method} ${op.path}` === key),
    );
    expect(stale, 'These cases name routes that no longer exist').toEqual([]);
  });

  it("NFR-SEC-01: every {orgId} route returns 404 for another organization's id", async () => {
    const scoped = operations.filter((op) => op.path.includes('{orgId}'));
    const failures: string[] = [];
    for (const op of scoped) {
      const params: Record<string, string> = {
        orgId: world.b.orgId,
        memberId: world.b.memberId,
        invitationId: world.b.invitationId,
        leadId: world.b.leadId,
        pipelineId: world.b.pipelineId,
        taskId: world.b.taskId,
        notificationId: world.b.notificationId,
      };
      const res = await call(world.a.owner, op, params);
      if (res.status !== 404) failures.push(`${op.method} ${op.path} → ${res.status}`);
    }
    expect(failures).toEqual([]);
    const { rows } = await app.sql.query('SELECT name FROM "Organization" WHERE id = $1', [
      world.b.orgId,
    ]);
    expect(rows[0].name).toBe(world.b.name);
  });

  it("NFR-SEC-01: routes with a nested id return 404 for another organization's record", async () => {
    for (const op of operations) {
      const key = `${op.method} ${op.path}`;
      if (key in NESTED) await NESTED[key]!(world, op);
    }
  });

  it('NFR-SEC-01: routes without {orgId} cannot reach another organization', async () => {
    for (const op of operations) {
      const key = `${op.method} ${op.path}`;
      if (key in UNSCOPED) await UNSCOPED[key]!(world, op);
    }
  });

  it("NFR-SEC-01: organization A's audit log holds no rows from organization B", async () => {
    const res = await world.a.owner.get(`/v1/orgs/${world.a.orgId}/audit-logs?limit=100`);
    expect(res.status).toBe(200);
    const leaked = res.body.items.filter(
      (e: { targetId: string | null }) =>
        e.targetId === world.b.orgId || e.targetId === world.b.invitationId,
    );
    expect(leaked).toEqual([]);
  });
});

describe('NFR-SEC-01 references across organizations', () => {
  it("NFR-SEC-01: a lead cannot point at another organization's stage or member", async () => {
    const stage = await world.a.owner.post(`/v1/orgs/${world.a.orgId}/leads`, {
      name: 'Cross stage',
      stageId: world.b.stageId,
    });
    expect(stage.status).toBe(422);
    expect(stage.body.errors[0].path).toBe('body.stageId');
    const owner = await world.a.owner.post(`/v1/orgs/${world.a.orgId}/leads`, {
      name: 'Cross owner',
      ownerId: world.b.memberUserId,
    });
    expect(owner.status).toBe(422);
    expect(owner.body.errors[0].path).toBe('body.ownerId');
  });

  it("NFR-SEC-01: a task cannot name another organization's lead or member", async () => {
    const onB = await world.a.owner.post(`/v1/orgs/${world.a.orgId}/tasks`, {
      leadId: world.b.leadId,
      title: 'Planted',
      type: 'CALL',
      dueAt: new Date(Date.now() + 3_600_000).toISOString(),
    });
    expect(onB.status).toBe(404);
    const own = await world.a.owner.post(`/v1/orgs/${world.a.orgId}/leads`, { name: 'A lead' });
    const toB = await world.a.owner.post(`/v1/orgs/${world.a.orgId}/tasks`, {
      leadId: own.body.id,
      title: 'For B',
      type: 'CALL',
      dueAt: new Date(Date.now() + 3_600_000).toISOString(),
      assigneeId: world.b.memberUserId,
    });
    expect(toB.status).toBe(422);
    const tasks = await world.a.owner.get(`/v1/orgs/${world.a.orgId}/tasks?status=all`);
    expect(tasks.body.items.map((t: { id: string }) => t.id)).not.toContain(world.b.taskId);
    const day = await world.a.owner.get(`/v1/orgs/${world.a.orgId}/me/day`);
    expect(JSON.stringify(day.body)).not.toContain(world.b.leadId);
  });

  it("NFR-SEC-01: search and filters never return another organization's leads", async () => {
    const res = await world.a.owner.get(`/v1/orgs/${world.a.orgId}/leads?q=Tenant%20B&limit=100`);
    expect(res.status).toBe(200);
    expect(res.body.items).toEqual([]);
    const byStage = await world.a.owner.get(
      `/v1/orgs/${world.a.orgId}/leads?stage=${world.b.stageId}`,
    );
    expect(byStage.body.items).toEqual([]);
  });
});
