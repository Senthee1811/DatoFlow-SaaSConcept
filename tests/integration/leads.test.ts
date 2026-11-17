import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  addMember,
  createOrg,
  setPlan,
  signUp,
  startApp,
  type Client,
  type TestApp,
} from './harness.js';

let app: TestApp;
beforeAll(async () => {
  app = await startApp();
});
afterAll(() => app.close());

interface Ws {
  owner: Client;
  ownerId: string;
  orgId: string;
  stages: { id: string; name: string; kind: string; slaHours: number }[];
  pipelineId: string;
  reasons: { id: string; label: string }[];
}

async function workspace(
  label: string,
  options: { sample?: boolean; country?: string } = {},
): Promise<Ws> {
  const owner = await signUp(app, label);
  const org = await createOrg(owner.client, label, options);
  const pipelines = await owner.client.get(`/v1/orgs/${org.id}/pipelines`);
  const reasons = await owner.client.get(`/v1/orgs/${org.id}/loss-reasons`);
  return {
    owner: owner.client,
    ownerId: owner.userId,
    orgId: org.id,
    stages: pipelines.body.items[0].stages,
    pipelineId: pipelines.body.items[0].id,
    reasons: reasons.body.items,
  };
}

const stage = (ws: Ws, kind: string, index = 0) => ws.stages.filter((s) => s.kind === kind)[index]!;

async function lead(ws: Ws, body: Record<string, unknown>, client = ws.owner) {
  const res = await client.post(`/v1/orgs/${ws.orgId}/leads`, body);
  if (res.status !== 201)
    throw new Error(`create lead failed: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body;
}

async function timeline(ws: Ws, leadId: string) {
  const res = await ws.owner.get(`/v1/orgs/${ws.orgId}/leads/${leadId}/activities?limit=100`);
  return res.body.items as {
    type: string;
    actor: { type: string; name: string };
    payload: Record<string, unknown>;
  }[];
}

describe('LEAD-01 create, view, edit, archive, restore', () => {
  it('LEAD-01: a lead keeps every field and lands in the first open stage', async () => {
    const ws = await workspace('lead01');
    const created = await lead(ws, {
      name: '  Amaya   Perera ',
      company: 'Lotus Dental Care',
      email: 'Amaya@Lotus.LK',
      phone: '077 123 4567',
      source: 'PAID_SOCIAL',
      priority: 'HIGH',
      dealValue: 250000,
      notes: 'Wants to start in December',
      utm: { source: 'facebook', medium: 'cpc', campaign: 'q4-leads' },
    });
    expect(created).toMatchObject({
      name: 'Amaya Perera',
      company: 'Lotus Dental Care',
      email: 'Amaya@Lotus.LK',
      emailNormalized: 'amaya@lotus.lk',
      phoneE164: '+94771234567',
      source: 'PAID_SOCIAL',
      priority: 'HIGH',
      dealValue: 250000,
      currency: 'LKR',
      stageId: stage(ws, 'OPEN').id,
      ownerId: ws.ownerId,
      utm: { source: 'facebook', medium: 'cpc', campaign: 'q4-leads' },
      archivedAt: null,
      isSample: false,
      canEdit: true,
    });
    expect(created.createdAt).toBeTruthy();
    expect(created.slaDueAt).toBeTruthy();

    const fetched = await ws.owner.get(`/v1/orgs/${ws.orgId}/leads/${created.id}`);
    expect(fetched.body.id).toBe(created.id);

    const edited = await ws.owner.patch(`/v1/orgs/${ws.orgId}/leads/${created.id}`, {
      company: 'Lotus Dental',
      priority: 'LOW',
    });
    expect(edited.body).toMatchObject({ company: 'Lotus Dental', priority: 'LOW' });

    const archived = await ws.owner.post(`/v1/orgs/${ws.orgId}/leads/${created.id}/archive`);
    expect(archived.body.archivedAt).toBeTruthy();
    const list = await ws.owner.get(`/v1/orgs/${ws.orgId}/leads`);
    expect(list.body.items.map((l: { id: string }) => l.id)).not.toContain(created.id);
    const archivedList = await ws.owner.get(`/v1/orgs/${ws.orgId}/leads?archived=true`);
    expect(archivedList.body.items.map((l: { id: string }) => l.id)).toContain(created.id);
    expect(
      (await ws.owner.patch(`/v1/orgs/${ws.orgId}/leads/${created.id}`, { name: 'X' })).status,
    ).toBe(409);

    const restored = await ws.owner.post(`/v1/orgs/${ws.orgId}/leads/${created.id}/restore`);
    expect(restored.body.archivedAt).toBeNull();
  });

  it('LEAD-01: unknown fields are rejected', async () => {
    const ws = await workspace('lead01-strict');
    const res = await ws.owner.post(`/v1/orgs/${ws.orgId}/leads`, {
      name: 'X',
      isSample: true,
      organizationId: 'other',
    });
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('VALIDATION_FAILED');
    const created = await lead(ws, { name: 'Y' });
    const patch = await ws.owner.patch(`/v1/orgs/${ws.orgId}/leads/${created.id}`, {
      archivedAt: null,
    });
    expect(patch.status).toBe(422);
  });
});

describe('LEAD-02 normalisation', () => {
  it('LEAD-02: invalid email returns a field-level 422', async () => {
    const ws = await workspace('lead02');
    const res = await ws.owner.post(`/v1/orgs/${ws.orgId}/leads`, {
      name: 'Bad',
      email: 'amaya@',
      phone: '12',
    });
    expect(res.status).toBe(422);
    expect(res.body.errors).toEqual([
      { path: 'body.email', message: 'Enter a valid email address' },
      { path: 'body.phone', message: 'Enter a valid phone number' },
    ]);
  });

  it("LEAD-02: phones use the organization's default country", async () => {
    const ws = await workspace('lead02-us', { country: 'US' });
    const created = await lead(ws, {
      name: 'Sam',
      phone: '(415) 555-2671',
      email: ' SAM@Example.com ',
    });
    expect(created).toMatchObject({
      phoneE164: '+14155552671',
      emailNormalized: 'sam@example.com',
    });
  });
});

describe('LEAD-03 duplicates', () => {
  it('LEAD-03: possible duplicates are linked on email, phone and name + company, never merged', async () => {
    const ws = await workspace('lead03');
    const first = await lead(ws, {
      name: 'Ruwan Silva',
      company: 'Kelani Logistics',
      email: 'ruwan@kelani.lk',
      phone: '0771234567',
    });
    const byEmail = await lead(ws, { name: 'R. Silva', email: 'RUWAN@kelani.lk' });
    const byPhone = await lead(ws, { name: 'Someone', phone: '+94 77 123 4567' });
    const byName = await lead(ws, { name: 'ruwan  silva', company: 'KELANI LOGISTICS' });
    const unrelated = await lead(ws, { name: 'Ruwan Silva', company: 'Other Co' });

    expect(byEmail.duplicates).toEqual([
      { leadId: first.id, name: 'Ruwan Silva', company: 'Kelani Logistics', reason: 'EMAIL' },
    ]);
    expect(byPhone.duplicates.map((d: { reason: string }) => d.reason)).toContain('PHONE');
    expect(byName.duplicates).toEqual([
      expect.objectContaining({ leadId: first.id, reason: 'NAME_COMPANY' }),
    ]);
    expect(unrelated.duplicates).toEqual([]);

    const original = await ws.owner.get(`/v1/orgs/${ws.orgId}/leads/${first.id}`);
    expect(original.body.duplicates.map((d: { leadId: string }) => d.leadId).sort()).toEqual(
      [byEmail.id, byPhone.id, byName.id].sort(),
    );
    // Never auto-merged: every lead still exists.
    const { rows } = await app.sql.query(
      'SELECT count(*)::int AS n FROM "Lead" WHERE "organizationId" = $1',
      [ws.orgId],
    );
    expect(rows[0].n).toBe(5);
    expect((await timeline(ws, byEmail.id)).map((a) => a.type)).toContain('DUPLICATE_FOUND');
  });

  it('LEAD-03: editing a lead into a match links it', async () => {
    const ws = await workspace('lead03-edit');
    const first = await lead(ws, { name: 'Kasun', email: 'kasun@x.lk' });
    const second = await lead(ws, { name: 'Other' });
    const edited = await ws.owner.patch(`/v1/orgs/${ws.orgId}/leads/${second.id}`, {
      email: 'Kasun@X.lk',
    });
    expect(edited.body.duplicates).toEqual([
      expect.objectContaining({ leadId: first.id, reason: 'EMAIL' }),
    ]);
  });
});

describe('Role scope on leads', () => {
  it('Sales Reps see their leads and the unassigned pool; others are 404', async () => {
    const ws = await workspace('scope');
    await setPlan(app, ws.orgId, 'starter');
    const rep = await addMember(app, ws.owner, ws.orgId, 'REP', 'scope-rep');
    const other = await addMember(app, ws.owner, ws.orgId, 'REP', 'scope-other');
    const mine = await lead(ws, { name: 'Mine', ownerId: rep.userId });
    const pool = await lead(ws, { name: 'Pool', ownerId: null });
    const theirs = await lead(ws, { name: 'Theirs', ownerId: other.userId });

    const list = await rep.client.get(`/v1/orgs/${ws.orgId}/leads`);
    expect(list.body.items.map((l: { name: string }) => l.name).sort()).toEqual(['Mine', 'Pool']);
    expect((await rep.client.get(`/v1/orgs/${ws.orgId}/leads/${theirs.id}`)).status).toBe(404);
    expect((await rep.client.get(`/v1/orgs/${ws.orgId}/leads/${pool.id}`)).body.canEdit).toBe(
      false,
    );

    // Edit: assigned only. Reassign, archive and listing archived: never.
    expect(
      (await rep.client.patch(`/v1/orgs/${ws.orgId}/leads/${mine.id}`, { priority: 'HIGH' }))
        .status,
    ).toBe(200);
    expect(
      (await rep.client.patch(`/v1/orgs/${ws.orgId}/leads/${pool.id}`, { priority: 'HIGH' }))
        .status,
    ).toBe(403);
    expect(
      (await rep.client.patch(`/v1/orgs/${ws.orgId}/leads/${mine.id}`, { ownerId: other.userId }))
        .status,
    ).toBe(403);
    expect((await rep.client.post(`/v1/orgs/${ws.orgId}/leads/${mine.id}/archive`)).status).toBe(
      403,
    );
    expect((await rep.client.get(`/v1/orgs/${ws.orgId}/leads?archived=true`)).status).toBe(403);
    expect(
      (
        await rep.client.post(`/v1/orgs/${ws.orgId}/leads/${mine.id}/activities`, {
          type: 'NOTE',
          text: 'Called back',
        })
      ).status,
    ).toBe(201);
    expect(
      (
        await rep.client.post(`/v1/orgs/${ws.orgId}/leads/${pool.id}/activities`, {
          type: 'NOTE',
          text: 'x',
        })
      ).status,
    ).toBe(403);

    // A Rep's new lead is theirs; they cannot give it to someone else.
    const own = await lead(ws, { name: 'Rep added' }, rep.client);
    expect(own.ownerId).toBe(rep.userId);
    expect(
      (await rep.client.post(`/v1/orgs/${ws.orgId}/leads`, { name: 'Gift', ownerId: other.userId }))
        .status,
    ).toBe(403);

    // "Reps can see all leads" widens visibility, not editing.
    await ws.owner.patch(`/v1/orgs/${ws.orgId}`, { settings: { repsCanSeeAllLeads: true } });
    const all = await rep.client.get(`/v1/orgs/${ws.orgId}/leads`);
    expect(all.body.items.map((l: { name: string }) => l.name)).toContain('Theirs');
    expect(
      (await rep.client.patch(`/v1/orgs/${ws.orgId}/leads/${theirs.id}`, { priority: 'LOW' }))
        .status,
    ).toBe(403);
  });
});

describe('LEAD-05 search, filters and saved filters', () => {
  let ws: Ws;
  let ids: Record<string, string>;
  beforeAll(async () => {
    ws = await workspace('lead05');
    const s = (i: number) => ws.stages[i]!.id;
    ids = {
      a: (
        await lead(ws, {
          name: 'Alpha Lead',
          company: 'Galle Fort Hotel',
          email: 'alpha@galle.lk',
          source: 'REFERRAL',
          priority: 'HIGH',
          stageId: s(0),
        })
      ).id,
      b: (
        await lead(ws, {
          name: 'Bravo',
          company: 'Coral Diving',
          phone: '0779876543',
          source: 'PAID_SEARCH',
          priority: 'LOW',
          stageId: s(1),
          ownerId: null,
        })
      ).id,
      c: (await lead(ws, { name: 'Charlie', source: 'PAID_SEARCH', stageId: s(2) })).id,
    };
    // Charlie went quiet past its SLA; Alpha was created last week.
    await app.sql.query(`UPDATE "Lead" SET "slaDueAt" = now() - interval '1 hour' WHERE id = $1`, [
      ids.c,
    ]);
    await app.sql.query(`UPDATE "Lead" SET "createdAt" = '2026-01-10T12:00:00Z' WHERE id = $1`, [
      ids.a,
    ]);
  });

  async function names(query: string) {
    const res = await ws.owner.get(`/v1/orgs/${ws.orgId}/leads?${query}`);
    expect(res.status, query).toBe(200);
    return res.body.items.map((l: { name: string }) => l.name).sort();
  }

  it('LEAD-05: search covers name, company, email and phone', async () => {
    expect(await names('q=galle')).toEqual(['Alpha Lead']);
    expect(await names('q=ALPHA@')).toEqual(['Alpha Lead']);
    expect(await names('q=9876543')).toEqual(['Bravo']);
    expect(await names('q=diving')).toEqual(['Bravo']);
  });

  it('LEAD-05: filters by owner, stage, source, priority, date and stuck status', async () => {
    expect(await names('owner=none')).toEqual(['Bravo']);
    expect(await names('owner=me')).toEqual(['Alpha Lead', 'Charlie']);
    expect(await names(`stage=${ws.stages[0]!.id},${ws.stages[1]!.id}`)).toEqual([
      'Alpha Lead',
      'Bravo',
    ]);
    expect(await names('source=PAID_SEARCH')).toEqual(['Bravo', 'Charlie']);
    expect(await names('priority=HIGH&priority=LOW')).toEqual(['Alpha Lead', 'Bravo']);
    expect(await names('createdTo=2026-01-10')).toEqual(['Alpha Lead']);
    expect(await names('createdFrom=2026-01-11')).toEqual(['Bravo', 'Charlie']);
    expect(await names('stuck=true')).toEqual(['Charlie']);
    expect(await names('stuck=false')).toEqual(['Alpha Lead', 'Bravo']);
    expect(await names('source=PAID_SEARCH&stuck=true')).toEqual(['Charlie']);
    expect((await ws.owner.get(`/v1/orgs/${ws.orgId}/leads?colour=red`)).status).toBe(422);
  });

  it('LEAD-05: lists page with a cursor in a stable order', async () => {
    const first = await ws.owner.get(`/v1/orgs/${ws.orgId}/leads?limit=2&sort=name_asc`);
    expect(first.body.items.map((l: { name: string }) => l.name)).toEqual(['Alpha Lead', 'Bravo']);
    const second = await ws.owner.get(
      `/v1/orgs/${ws.orgId}/leads?limit=2&sort=name_asc&cursor=${first.body.nextCursor}`,
    );
    expect(second.body.items.map((l: { name: string }) => l.name)).toEqual(['Charlie']);
    expect(second.body.nextCursor).toBeNull();
    const sla = await ws.owner.get(`/v1/orgs/${ws.orgId}/leads?sort=sla_asc`);
    expect(sla.body.items[0].name).toBe('Charlie');
    expect(sla.body.items[0].stuck).toBe(true);
  });

  it('LEAD-05: filters persist per user', async () => {
    const saved = {
      leadFilters: { source: ['PAID_SEARCH'], stuck: true, sort: 'sla_asc' },
      leadView: 'board',
    };
    expect(
      (await ws.owner.request('PUT', `/v1/orgs/${ws.orgId}/me/preferences`, saved)).status,
    ).toBe(200);
    expect((await ws.owner.get(`/v1/orgs/${ws.orgId}/me/preferences`)).body).toEqual(saved);
    expect(
      (await ws.owner.request('PUT', `/v1/orgs/${ws.orgId}/me/preferences`, { theme: 'dark' }))
        .status,
    ).toBe(422);
    // Another member's preferences are their own.
    await setPlan(app, ws.orgId, 'starter');
    const manager = await addMember(app, ws.owner, ws.orgId, 'MANAGER', 'prefs-manager');
    expect((await manager.client.get(`/v1/orgs/${ws.orgId}/me/preferences`)).body).toEqual({});
  });
});

describe('LEAD-06 activity timeline', () => {
  it('LEAD-06: every change, note and move is on the timeline', async () => {
    const ws = await workspace('lead06');
    await setPlan(app, ws.orgId, 'starter');
    const rep = await addMember(app, ws.owner, ws.orgId, 'REP', 'timeline-rep');
    const created = await lead(ws, { name: 'Timeline Lead', ownerId: null });
    const url = `/v1/orgs/${ws.orgId}/leads/${created.id}`;
    await ws.owner.patch(url, { company: 'New Co', dealValue: 1200 });
    await ws.owner.patch(url, { stageId: ws.stages[1]!.id });
    await ws.owner.patch(url, { ownerId: rep.userId });
    await ws.owner.post(`${url}/activities`, { type: 'NOTE', text: 'Prefers WhatsApp' });
    await ws.owner.post(`${url}/archive`);
    await ws.owner.post(`${url}/restore`);

    const items = await timeline(ws, created.id);
    expect(items.map((a) => a.type).reverse()).toEqual([
      'CREATED',
      'UPDATED',
      'STAGE_CHANGED',
      'ASSIGNED',
      'NOTE',
      'ARCHIVED',
      'RESTORED',
    ]);
    const updated = items.find((a) => a.type === 'UPDATED')!;
    expect(updated.payload.changes).toEqual([
      { field: 'company', from: null, to: 'New Co' },
      { field: 'dealValue', from: null, to: 1200 },
    ]);
    expect(items.find((a) => a.type === 'ASSIGNED')!.payload).toEqual({
      fromOwnerId: null,
      toOwnerId: rep.userId,
    });
    expect(items.every((a) => a.actor.type === 'USER' && a.actor.name.length > 0)).toBe(true);
  });

  it('LEAD-06: workflow changes show the actor as "Workflow: name"', async () => {
    const ws = await workspace('lead06-wf');
    const created = await lead(ws, { name: 'Automated' });
    await app.sql.query(
      `INSERT INTO "LeadActivity" (id, "organizationId", "leadId", type, "actorType", "actorId", "actorLabel", payload)
       VALUES (gen_random_uuid(), $1, $2, 'ASSIGNED', 'WORKFLOW', 'wf-1', 'Round-robin new leads', '{}')`,
      [ws.orgId, created.id],
    );
    const items = await timeline(ws, created.id);
    expect(items[0]!.actor).toEqual({
      type: 'WORKFLOW',
      id: 'wf-1',
      name: 'Workflow: Round-robin new leads',
    });
  });
});

describe('PIPE-01 stage configuration', () => {
  it('PIPE-01: add, rename, reorder, set SLA hours and mark Won or Lost', async () => {
    const ws = await workspace('pipe01');
    const [n, c, q, p, won, lost] = ws.stages;
    const res = await ws.owner.patch(`/v1/orgs/${ws.orgId}/pipelines/${ws.pipelineId}/stages`, {
      stages: [
        { id: c!.id, name: 'First call', slaHours: 24, kind: 'OPEN' },
        { id: n!.id, name: 'Inbox', slaHours: 4, kind: 'OPEN' },
        { name: 'Discovery', slaHours: 48, kind: 'OPEN' },
        { id: q!.id, name: q!.name, slaHours: 72, kind: 'OPEN' },
        { id: p!.id, name: p!.name, slaHours: 72, kind: 'OPEN' },
        { id: won!.id, name: 'Signed', slaHours: 72, kind: 'WON' },
        { id: lost!.id, name: 'Lost', slaHours: 72, kind: 'LOST' },
      ],
    });
    expect(res.status).toBe(200);
    expect(res.body.stages.map((s: { name: string }) => s.name)).toEqual([
      'First call',
      'Inbox',
      'Discovery',
      'Qualified',
      'Proposal',
      'Signed',
      'Lost',
    ]);
    expect(res.body.stages.map((s: { order: number }) => s.order)).toEqual([0, 1, 2, 3, 4, 5, 6]);
  });

  it('PIPE-01: a stage that holds leads cannot be deleted until they are moved', async () => {
    const ws = await workspace('pipe01-delete');
    const held = await lead(ws, { name: 'Holder', stageId: ws.stages[1]!.id });
    const without = ws.stages
      .filter((_, i) => i !== 1)
      .map(({ id, name, slaHours, kind }) => ({ id, name, slaHours, kind }));
    const blocked = await ws.owner.patch(`/v1/orgs/${ws.orgId}/pipelines/${ws.pipelineId}/stages`, {
      stages: without,
    });
    expect(blocked.status).toBe(409);
    expect(blocked.body).toMatchObject({ code: 'STAGE_NOT_EMPTY', ids: [ws.stages[1]!.id] });

    await ws.owner.patch(`/v1/orgs/${ws.orgId}/leads/${held.id}`, { stageId: ws.stages[0]!.id });
    const ok = await ws.owner.patch(`/v1/orgs/${ws.orgId}/pipelines/${ws.pipelineId}/stages`, {
      stages: without,
    });
    expect(ok.status).toBe(200);
    expect(ok.body.stages).toHaveLength(5);
  });

  it('PIPE-01: a new SLA applies to leads already in the stage', async () => {
    const ws = await workspace('pipe01-sla');
    const created = await lead(ws, { name: 'Clock' });
    const stages = ws.stages.map(({ id, name, slaHours, kind }, i) => ({
      id,
      name,
      kind,
      slaHours: i === 0 ? 2 : slaHours,
    }));
    await ws.owner.patch(`/v1/orgs/${ws.orgId}/pipelines/${ws.pipelineId}/stages`, { stages });
    const after = await ws.owner.get(`/v1/orgs/${ws.orgId}/leads/${created.id}`);
    const hours =
      (Date.parse(after.body.slaDueAt) - Date.parse(after.body.lastActivityAt)) / 3_600_000;
    expect(hours).toBeCloseTo(2, 5);
  });

  it('PIPE-01: invalid stage lists are refused, and only Owners and Admins configure stages', async () => {
    const ws = await workspace('pipe01-rules');
    const noWon = ws.stages
      .filter((s) => s.kind !== 'WON')
      .map(({ id, name, slaHours, kind }) => ({ id, name, slaHours, kind }));
    const res = await ws.owner.patch(`/v1/orgs/${ws.orgId}/pipelines/${ws.pipelineId}/stages`, {
      stages: noWon,
    });
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('INVALID_STAGES');
    await setPlan(app, ws.orgId, 'starter');
    const manager = await addMember(app, ws.owner, ws.orgId, 'MANAGER', 'pipe-manager');
    const all = ws.stages.map(({ id, name, slaHours, kind }) => ({ id, name, slaHours, kind }));
    expect(
      (
        await manager.client.patch(`/v1/orgs/${ws.orgId}/pipelines/${ws.pipelineId}/stages`, {
          stages: all,
        })
      ).status,
    ).toBe(403);
    expect((await manager.client.get(`/v1/orgs/${ws.orgId}/pipelines`)).status).toBe(200);
  });
});

describe('PIPE-03 Won and Lost rules', () => {
  it('PIPE-03: Lost requires a loss reason', async () => {
    const ws = await workspace('pipe03-lost');
    const created = await lead(ws, { name: 'Lost one' });
    const url = `/v1/orgs/${ws.orgId}/leads/${created.id}`;
    const refused = await ws.owner.patch(url, { stageId: stage(ws, 'LOST').id });
    expect(refused.status).toBe(422);
    expect(refused.body).toMatchObject({
      code: 'LOSS_REASON_REQUIRED',
      errors: [{ path: 'body.lossReasonId' }],
    });
    expect((await ws.owner.get(url)).body.stageId).toBe(stage(ws, 'OPEN').id);
    const ok = await ws.owner.patch(url, {
      stageId: stage(ws, 'LOST').id,
      lossReasonId: ws.reasons[0]!.id,
    });
    expect(ok.body).toMatchObject({
      stageId: stage(ws, 'LOST').id,
      lossReasonId: ws.reasons[0]!.id,
      slaDueAt: null,
    });
    expect(ok.body.closedAt).toBeTruthy();
    // Reopening clears the reason.
    const reopened = await ws.owner.patch(url, { stageId: stage(ws, 'OPEN').id });
    expect(reopened.body).toMatchObject({ lossReasonId: null, closedAt: null });
  });

  it('PIPE-03: Won requires a deal value, unless the org setting is off', async () => {
    const ws = await workspace('pipe03-won');
    const created = await lead(ws, { name: 'Won one' });
    const url = `/v1/orgs/${ws.orgId}/leads/${created.id}`;
    const refused = await ws.owner.patch(url, { stageId: stage(ws, 'WON').id });
    expect(refused.body).toMatchObject({
      code: 'DEAL_VALUE_REQUIRED',
      errors: [{ path: 'body.dealValue' }],
    });
    expect(
      (await ws.owner.patch(url, { stageId: stage(ws, 'WON').id, dealValue: 480000 })).status,
    ).toBe(200);

    const other = await lead(ws, { name: 'Won without value' });
    await ws.owner.patch(`/v1/orgs/${ws.orgId}`, { settings: { wonRequiresDealValue: false } });
    expect(
      (
        await ws.owner.patch(`/v1/orgs/${ws.orgId}/leads/${other.id}`, {
          stageId: stage(ws, 'WON').id,
        })
      ).status,
    ).toBe(200);
  });
});

describe('Transactional outbox', () => {
  it('lead.created, lead.stage_changed and lead.assigned are written with the change; a refused change writes nothing', async () => {
    const ws = await workspace('outbox');
    await setPlan(app, ws.orgId, 'starter');
    const rep = await addMember(app, ws.owner, ws.orgId, 'REP', 'outbox-rep');
    const created = await lead(ws, { name: 'Events' });
    const url = `/v1/orgs/${ws.orgId}/leads/${created.id}`;
    await ws.owner.patch(url, { stageId: ws.stages[1]!.id, ownerId: rep.userId });
    await ws.owner.patch(url, { stageId: stage(ws, 'LOST').id });

    const { rows } = await app.sql.query(
      `SELECT type, payload FROM "OutboxEvent" WHERE "aggregateId" = $1 ORDER BY "createdAt", type`,
      [created.id],
    );
    expect(rows.map((r) => r.type).sort()).toEqual([
      'lead.assigned',
      'lead.created',
      'lead.stage_changed',
    ]);
    expect(rows.find((r) => r.type === 'lead.stage_changed')!.payload).toMatchObject({
      fromStageId: ws.stages[0]!.id,
      toStageId: ws.stages[1]!.id,
    });
    const { rows: unpublished } = await app.sql.query(
      `SELECT count(*)::int AS n FROM "OutboxEvent" WHERE "aggregateId" = $1 AND "publishedAt" IS NULL`,
      [created.id],
    );
    expect(unpublished[0].n).toBe(3);
  });
});

describe('ORG-04 sample workspace', () => {
  it('ORG-04: a new workspace holds a fictional agency with 60 leads and 3 reps, all sample', async () => {
    const ws = await workspace('org04', { sample: true });
    const { rows } = await app.sql.query(
      `SELECT count(*) FILTER (WHERE "isSample")::int AS sample, count(*)::int AS total FROM "Lead" WHERE "organizationId" = $1`,
      [ws.orgId],
    );
    expect(rows[0]).toEqual({ sample: 60, total: 60 });
    const reps = await ws.owner.get(`/v1/orgs/${ws.orgId}/assignees`);
    expect(reps.body.items.filter((a: { isSample: boolean }) => a.isSample)).toHaveLength(3);
    expect((await ws.owner.get(`/v1/orgs/${ws.orgId}`)).body.hasSampleData).toBe(true);
    // Sample reps never take a seat: the Free plan still has room for one invitation.
    expect(
      (
        await ws.owner.post(`/v1/orgs/${ws.orgId}/invitations`, {
          email: 'real-rep@example.test',
          role: 'REP',
        })
      ).status,
    ).toBe(201);
    // The sample includes stuck leads and a possible duplicate, so the features have something to show.
    expect(
      (await ws.owner.get(`/v1/orgs/${ws.orgId}/leads?stuck=true`)).body.items.length,
    ).toBeGreaterThan(0);
    const { rows: dups } = await app.sql.query(
      `SELECT count(*)::int AS n FROM "LeadDuplicate" WHERE "organizationId" = $1`,
      [ws.orgId],
    );
    expect(dups[0].n).toBeGreaterThan(0);
  });

  it('ORG-04: "Delete sample data" removes only sample records', async () => {
    const ws = await workspace('org04-delete', { sample: true });
    const sampleRep = (await ws.owner.get(`/v1/orgs/${ws.orgId}/assignees`)).body.items.find(
      (a: { isSample: boolean }) => a.isSample,
    );
    const real = await lead(ws, { name: 'Real Lead', email: 'real@client.lk' });
    const handedToSampleRep = await lead(ws, {
      name: 'Real, sample owner',
      ownerId: sampleRep.userId,
    });
    await ws.owner.post(`/v1/orgs/${ws.orgId}/leads/${real.id}/activities`, {
      type: 'NOTE',
      text: 'Real note',
    });

    const res = await ws.owner.delete(`/v1/orgs/${ws.orgId}/sample-data`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ leads: 60, reps: 3, workflows: 2 });

    const { rows } = await app.sql.query(
      `SELECT name, "ownerId" FROM "Lead" WHERE "organizationId" = $1 ORDER BY name`,
      [ws.orgId],
    );
    expect(rows).toEqual([
      { name: 'Real Lead', ownerId: ws.ownerId },
      { name: 'Real, sample owner', ownerId: null },
    ]);
    expect((await timeline(ws, real.id)).map((a) => a.type)).toContain('NOTE');
    expect(
      (await ws.owner.get(`/v1/orgs/${ws.orgId}/leads/${handedToSampleRep.id}`)).body.ownerId,
    ).toBeNull();
    const { rows: users } = await app.sql.query(
      `SELECT count(*)::int AS n FROM "User" WHERE email LIKE $1`,
      [`%.${ws.orgId}@sample.datoflow.invalid`],
    );
    expect(users[0].n).toBe(0);
    const members = await ws.owner.get(`/v1/orgs/${ws.orgId}/members`);
    expect(members.body.items).toHaveLength(1);
    expect((await ws.owner.get(`/v1/orgs/${ws.orgId}`)).body.hasSampleData).toBe(false);
    const audit = await ws.owner.get(`/v1/orgs/${ws.orgId}/audit-logs`);
    expect(audit.body.items[0]).toMatchObject({
      action: 'sample.deleted',
      metadata: { leads: 60, reps: 3, workflows: 2 },
    });
  });

  it('ORG-04: only Owners and Admins delete sample data', async () => {
    const ws = await workspace('org04-role', { sample: true });
    const manager = await addMember(app, ws.owner, ws.orgId, 'MANAGER', 'sample-manager');
    expect((await manager.client.delete(`/v1/orgs/${ws.orgId}/sample-data`)).status).toBe(403);
  });
});
