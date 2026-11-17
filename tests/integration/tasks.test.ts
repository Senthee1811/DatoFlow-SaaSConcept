import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  addMember,
  createOrg,
  inMinutes,
  setPlan,
  signUp,
  startApp,
  startWorker,
  type Client,
  type TestApp,
  type TestWorker,
} from './harness.js';

let app: TestApp;
let worker: TestWorker;
beforeAll(async () => {
  app = await startApp();
  worker = await startWorker(app);
});
afterAll(async () => {
  await worker.close();
  await app.close();
});

interface Ws {
  owner: Client;
  ownerId: string;
  orgId: string;
  stages: { id: string; name: string; kind: string; slaHours: number }[];
  reasons: { id: string; label: string }[];
}

async function workspace(label: string): Promise<Ws> {
  const owner = await signUp(app, label);
  const org = await createOrg(owner.client, label);
  await setPlan(app, org.id, 'starter');
  const pipelines = await owner.client.get(`/v1/orgs/${org.id}/pipelines`);
  const reasons = await owner.client.get(`/v1/orgs/${org.id}/loss-reasons`);
  return {
    owner: owner.client,
    ownerId: owner.userId,
    orgId: org.id,
    stages: pipelines.body.items[0].stages,
    reasons: reasons.body.items,
  };
}

const stage = (ws: Ws, kind: string) => ws.stages.find((s) => s.kind === kind)!;

async function lead(ws: Ws, body: Record<string, unknown> = {}, client = ws.owner) {
  const res = await client.post(`/v1/orgs/${ws.orgId}/leads`, { name: 'Amaya Perera', ...body });
  if (res.status !== 201) throw new Error(`lead failed: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body as { id: string };
}

async function task(ws: Ws, body: Record<string, unknown>, client = ws.owner) {
  return client.post(`/v1/orgs/${ws.orgId}/tasks`, {
    title: 'Call back about pricing',
    type: 'CALL',
    dueAt: inMinutes(120),
    ...body,
  });
}

const getLead = (ws: Ws, id: string, client = ws.owner) =>
  client.get(`/v1/orgs/${ws.orgId}/leads/${id}`).then((r) => r.body);

async function timeline(ws: Ws, leadId: string) {
  const res = await ws.owner.get(`/v1/orgs/${ws.orgId}/leads/${leadId}/activities?limit=100`);
  return res.body.items as { type: string; actor: { name: string }; payload: any }[];
}

const touch = (ws: Ws, leadId: string, body: Record<string, unknown>, client = ws.owner) =>
  client.post(`/v1/orgs/${ws.orgId}/leads/${leadId}/activities`, {
    type: 'TOUCH',
    channel: 'CALL',
    ...body,
  });

describe('TASK-01 tasks', () => {
  it('TASK-01: a task keeps its title, type, due time, priority, assignee, lead and status', async () => {
    const ws = await workspace('task01');
    const l = await lead(ws);
    const due = inMinutes(90);
    const res = await task(ws, {
      leadId: l.id,
      title: 'Send the proposal',
      type: 'EMAIL',
      dueAt: due,
      priority: 'HIGH',
    });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      leadId: l.id,
      leadName: 'Amaya Perera',
      title: 'Send the proposal',
      type: 'EMAIL',
      dueAt: new Date(due).toISOString(),
      priority: 'HIGH',
      assigneeId: ws.ownerId,
      status: 'OPEN',
      overdue: false,
      canEdit: true,
    });
    // The lead now has a next step.
    expect((await getLead(ws, l.id)).nextStepDueAt).toBe(new Date(due).toISOString());

    const done = await ws.owner.patch(`/v1/orgs/${ws.orgId}/tasks/${res.body.id}`, {
      status: 'DONE',
    });
    expect(done.body).toMatchObject({ status: 'DONE' });
    expect(done.body.completedAt).toBeTruthy();
    expect((await getLead(ws, l.id)).nextStepDueAt).toBeNull();
    const types = (await timeline(ws, l.id)).map((a) => a.type);
    expect(types).toEqual(expect.arrayContaining(['TASK_CREATED', 'TASK_COMPLETED']));
  });

  it('TASK-01: the assignee must be a member of the same organization', async () => {
    const ws = await workspace('task01m');
    const other = await workspace('task01o');
    const l = await lead(ws);
    const res = await task(ws, { leadId: l.id, assigneeId: other.ownerId });
    expect(res.status).toBe(422);
    expect(res.body.errors[0].path).toBe('body.assigneeId');
    const unknown = await task(ws, { leadId: l.id, assigneeId: 'no-such-user' });
    expect(unknown.status).toBe(422);
  });

  it('TASK-01: unknown fields and a due time without an offset are refused', async () => {
    const ws = await workspace('task01v');
    const l = await lead(ws);
    expect((await task(ws, { leadId: l.id, status: 'DONE' })).status).toBe(422);
    expect((await task(ws, { leadId: l.id, dueAt: '2026-11-20T10:00:00' })).status).toBe(422);
    expect((await task(ws, { leadId: l.id, type: 'FAX' })).status).toBe(422);
  });

  it('TASK-01: Sales Reps give tasks only to themselves and see only their own', async () => {
    const ws = await workspace('task01r');
    const rep = await addMember(app, ws.owner, ws.orgId, 'REP', 'task01-rep');
    const other = await addMember(app, ws.owner, ws.orgId, 'REP', 'task01-rep2');
    const repLead = await lead(ws, { ownerId: rep.userId });
    const otherLead = await lead(ws, { ownerId: other.userId });

    const mine = await task(ws, { leadId: repLead.id }, rep.client);
    expect(mine.status).toBe(201);
    expect(mine.body.assigneeId).toBe(rep.userId);
    const forOther = await task(ws, { leadId: repLead.id, assigneeId: ws.ownerId }, rep.client);
    expect(forOther.status).toBe(403);
    // A lead outside the rep's scope looks like one that does not exist.
    expect((await task(ws, { leadId: otherLead.id }, rep.client)).status).toBe(404);

    // A manager cannot give a rep a task on a lead the rep cannot see.
    const hidden = await task(ws, { leadId: otherLead.id, assigneeId: rep.userId });
    expect(hidden.status).toBe(422);
    expect(hidden.body.errors[0].path).toBe('body.assigneeId');

    const ownersTask = await task(ws, { leadId: repLead.id, assigneeId: ws.ownerId });
    expect(ownersTask.status).toBe(201);
    const list = await rep.client.get(`/v1/orgs/${ws.orgId}/tasks`);
    expect(list.body.items.map((t: { id: string }) => t.id)).toEqual([mine.body.id]);
    // With a lead, the rep sees every task on it, but can change only their own.
    const onLead = await rep.client.get(`/v1/orgs/${ws.orgId}/tasks?leadId=${repLead.id}`);
    expect(onLead.body.items).toHaveLength(2);
    const theirs = onLead.body.items.find((t: { id: string }) => t.id === ownersTask.body.id);
    expect(theirs.canEdit).toBe(false);
    const change = await rep.client.patch(`/v1/orgs/${ws.orgId}/tasks/${ownersTask.body.id}`, {
      status: 'DONE',
    });
    expect(change.status).toBe(403);
    expect((await rep.client.get(`/v1/orgs/${ws.orgId}/tasks?assignee=${ws.ownerId}`)).status).toBe(
      403,
    );
  });

  it('TASK-01: an archived lead takes no new tasks', async () => {
    const ws = await workspace('task01a');
    const l = await lead(ws);
    await ws.owner.post(`/v1/orgs/${ws.orgId}/leads/${l.id}/archive`);
    expect((await task(ws, { leadId: l.id })).status).toBe(409);
  });
});

describe('TASK-02 the next-step rule', () => {
  it('TASK-02: a touch on an open lead without a next step returns 422 NEXT_STEP_REQUIRED and saves nothing', async () => {
    const ws = await workspace('task02');
    const l = await lead(ws);
    const before = await getLead(ws, l.id);
    const res = await touch(ws, l.id, { text: 'Called, no answer' });
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('NEXT_STEP_REQUIRED');
    expect(res.body.errors[0].path).toBe('body.nextStep');
    expect((await timeline(ws, l.id)).some((a) => a.type === 'TOUCH')).toBe(false);
    expect((await getLead(ws, l.id)).lastActivityAt).toBe(before.lastActivityAt);
  });

  it('TASK-02: a touch with a next step saves both and restarts the SLA clock', async () => {
    const ws = await workspace('task02b');
    const l = await lead(ws);
    const before = await getLead(ws, l.id);
    const due = inMinutes(60 * 24);
    const res = await touch(ws, l.id, {
      channel: 'WHATSAPP',
      text: 'Sent the price list',
      nextStep: { title: 'Ask if the price list helped', type: 'CALL', dueAt: due },
    });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      warning: null,
      nextStep: { title: 'Ask if the price list helped', status: 'OPEN' },
    });
    const after = await getLead(ws, l.id);
    expect(Date.parse(after.lastActivityAt)).toBeGreaterThan(Date.parse(before.lastActivityAt));
    expect(after.nextStepDueAt).toBe(new Date(due).toISOString());
    const entry = (await timeline(ws, l.id)).find((a) => a.type === 'TOUCH')!;
    expect(entry.payload).toEqual({ channel: 'WHATSAPP', text: 'Sent the price list' });
  });

  it('TASK-02: an existing open task does not count; the touch needs a new one', async () => {
    const ws = await workspace('task02e');
    const l = await lead(ws);
    await task(ws, { leadId: l.id });
    expect((await touch(ws, l.id, {})).status).toBe(422);
  });

  it('TASK-02: the touch can complete the task it took care of', async () => {
    const ws = await workspace('task02c');
    const l = await lead(ws);
    const first = await task(ws, { leadId: l.id, dueAt: inMinutes(-30) });
    const res = await touch(ws, l.id, {
      completeTaskIds: [first.body.id],
      nextStep: { title: 'Meeting', type: 'MEETING', dueAt: inMinutes(60 * 48) },
    });
    expect(res.status).toBe(201);
    const tasks = await ws.owner.get(`/v1/orgs/${ws.orgId}/tasks?leadId=${l.id}&status=all`);
    const byTitle = Object.fromEntries(
      tasks.body.items.map((t: { title: string; status: string }) => [t.title, t.status]),
    );
    expect(byTitle).toEqual({ 'Call back about pricing': 'DONE', Meeting: 'OPEN' });
  });

  it('TASK-02: a touch that marks the lead Won or Lost needs no next step', async () => {
    const ws = await workspace('task02w');
    const won = await lead(ws, { dealValue: 120000 });
    const res = await touch(ws, won.id, { close: { stageId: stage(ws, 'WON').id } });
    expect(res.status).toBe(201);
    expect((await getLead(ws, won.id)).stageId).toBe(stage(ws, 'WON').id);

    const lost = await lead(ws);
    // Lost still needs its loss reason (PIPE-03), and nothing is saved without it.
    const noReason = await touch(ws, lost.id, { close: { stageId: stage(ws, 'LOST').id } });
    expect(noReason.status).toBe(422);
    expect(noReason.body.code).toBe('LOSS_REASON_REQUIRED');
    expect((await timeline(ws, lost.id)).some((a) => a.type === 'TOUCH')).toBe(false);
    const ok = await touch(ws, lost.id, {
      close: { stageId: stage(ws, 'LOST').id, lossReasonId: ws.reasons[0]!.id },
    });
    expect(ok.status).toBe(201);
    const types = (await timeline(ws, lost.id)).map((a) => a.type);
    expect(types).toEqual(expect.arrayContaining(['TOUCH', 'STAGE_CHANGED']));

    // An open stage is not a way to close.
    const open = await lead(ws);
    const wrong = await touch(ws, open.id, { close: { stageId: stage(ws, 'OPEN').id } });
    expect(wrong.status).toBe(422);
  });

  it('TASK-02: an organization can switch to "warn only"', async () => {
    const ws = await workspace('task02x');
    const set = await ws.owner.patch(`/v1/orgs/${ws.orgId}`, {
      settings: { nextStepRule: 'warn' },
    });
    expect(set.status).toBe(200);
    const l = await lead(ws);
    const res = await touch(ws, l.id, { channel: 'EMAIL' });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ warning: 'NEXT_STEP_MISSING', nextStep: null });
    expect((await timeline(ws, l.id)).find((a) => a.type === 'TOUCH')!.payload.warning).toBe(
      'NEXT_STEP_MISSING',
    );
  });

  it('TASK-02: a Sales Rep logs touches only on leads assigned to them', async () => {
    const ws = await workspace('task02r');
    const rep = await addMember(app, ws.owner, ws.orgId, 'REP', 'task02-rep');
    const pool = await lead(ws, { ownerId: null });
    const nextStep = { title: 'Follow up', type: 'CALL', dueAt: inMinutes(600) };
    expect((await touch(ws, pool.id, { nextStep }, rep.client)).status).toBe(403);
    const mine = await lead(ws, { ownerId: rep.userId });
    expect((await touch(ws, mine.id, { nextStep }, rep.client)).status).toBe(201);
  });
});

describe('TASK-03 overdue markers and the stuck-lead radar', () => {
  it('TASK-03: an overdue next step makes a lead stuck at once, and doing it clears the flag', async () => {
    const ws = await workspace('task03');
    const l = await lead(ws);
    const late = await task(ws, { leadId: l.id, dueAt: inMinutes(-10) });
    expect(late.body.overdue).toBe(true);
    const stuck = await getLead(ws, l.id);
    expect(stuck).toMatchObject({ stuck: true, stuckReasons: ['NEXT_STEP_OVERDUE'] });
    expect(stuck.stuckAt).toBeTruthy();
    const flagged = (await timeline(ws, l.id)).filter((a) => a.type === 'STUCK');
    expect(flagged).toHaveLength(1);
    expect(flagged[0]).toMatchObject({
      actor: { name: 'Stuck-lead radar' },
      payload: { reasons: ['NEXT_STEP_OVERDUE'] },
    });
    const list = await ws.owner.get(`/v1/orgs/${ws.orgId}/leads?stuck=true`);
    expect(list.body.items.map((x: { id: string }) => x.id)).toEqual([l.id]);

    await ws.owner.patch(`/v1/orgs/${ws.orgId}/tasks/${late.body.id}`, { status: 'DONE' });
    const after = await getLead(ws, l.id);
    expect(after).toMatchObject({ stuck: false, stuckReasons: [], stuckAt: null });
    expect((await ws.owner.get(`/v1/orgs/${ws.orgId}/leads?stuck=false`)).body.items).toHaveLength(
      1,
    );
  });

  it('TASK-03: the 5-minute sweep flags a lead whose next step went overdue with no other change, once', async () => {
    const ws = await workspace('task03s');
    const l = await lead(ws);
    const t = await task(ws, { leadId: l.id, dueAt: inMinutes(30) });
    expect((await getLead(ws, l.id)).stuck).toBe(false);
    // Time passes: the step is now 5 minutes late, but nothing in the app changed.
    await app.sql.query(`UPDATE "Task" SET "dueAt" = now() - interval '5 minutes' WHERE id = $1`, [
      t.body.id,
    ]);
    await app.sql.query(
      `UPDATE "Lead" SET "nextStepDueAt" = now() - interval '5 minutes' WHERE id = $1`,
      [l.id],
    );
    expect((await getLead(ws, l.id)).stuckAt).toBeNull();
    const sweep = await worker.jobs.radar();
    expect(sweep.flagged).toBeGreaterThanOrEqual(1);
    expect((await getLead(ws, l.id)).stuckAt).toBeTruthy();
    await worker.jobs.radar();
    expect((await timeline(ws, l.id)).filter((a) => a.type === 'STUCK')).toHaveLength(1);
  });

  it('TASK-03: the sweep flags a lead that went quiet past its stage SLA, and clears it on a touch', async () => {
    const ws = await workspace('task03q');
    const l = await lead(ws);
    await app.sql.query(`UPDATE "Lead" SET "slaDueAt" = now() - interval '1 hour' WHERE id = $1`, [
      l.id,
    ]);
    await worker.jobs.radar();
    expect(await getLead(ws, l.id)).toMatchObject({ stuck: true, stuckReasons: ['SLA'] });
    const res = await touch(ws, l.id, {
      nextStep: { title: 'Follow up', type: 'CALL', dueAt: inMinutes(600) },
    });
    expect(res.status).toBe(201);
    expect(await getLead(ws, l.id)).toMatchObject({ stuck: false, stuckAt: null });
  });

  it('TASK-03: closed and archived leads drop off the radar', async () => {
    const ws = await workspace('task03c');
    const a = await lead(ws);
    await task(ws, { leadId: a.id, dueAt: inMinutes(-10) });
    expect((await getLead(ws, a.id)).stuck).toBe(true);
    await ws.owner.post(`/v1/orgs/${ws.orgId}/leads/${a.id}/archive`);
    expect(
      (await ws.owner.get(`/v1/orgs/${ws.orgId}/leads?stuck=true&archived=true`)).body.items,
    ).toEqual([]);
    const b = await lead(ws, { dealValue: 5000 });
    await task(ws, { leadId: b.id, dueAt: inMinutes(-10) });
    await ws.owner.patch(`/v1/orgs/${ws.orgId}/leads/${b.id}`, { stageId: stage(ws, 'WON').id });
    expect(await getLead(ws, b.id)).toMatchObject({
      stuck: false,
      nextStepDueAt: null,
      stuckAt: null,
    });
  });

  it('TASK-03: shortening a stage SLA runs the radar on the leads in it', async () => {
    const ws = await workspace('task03p');
    const l = await lead(ws);
    await app.sql.query(
      `UPDATE "Lead" SET "lastActivityAt" = now() - interval '3 hours', "slaDueAt" = now() + interval '69 hours' WHERE id = $1`,
      [l.id],
    );
    const pipelines = await ws.owner.get(`/v1/orgs/${ws.orgId}/pipelines`);
    const pipeline = pipelines.body.items[0];
    const res = await ws.owner.request(
      'PATCH',
      `/v1/orgs/${ws.orgId}/pipelines/${pipeline.id}/stages`,
      {
        stages: pipeline.stages.map(
          (s: { id: string; name: string; kind: string; slaHours: number }, i: number) => ({
            id: s.id,
            name: s.name,
            kind: s.kind,
            slaHours: i === 0 ? 1 : s.slaHours,
          }),
        ),
      },
    );
    expect(res.status).toBe(200);
    const after = await getLead(ws, l.id);
    expect(after).toMatchObject({ stuck: true, stuckReasons: ['SLA'] });
    expect(after.stuckAt).toBeTruthy();
  });
});

describe('TASK-05 My day', () => {
  it('TASK-05: overdue next steps, then due today, then stuck leads assigned to the rep', async () => {
    const ws = await workspace('task05');
    const rep = await addMember(app, ws.owner, ws.orgId, 'REP', 'task05-rep');
    // UTC keeps "today" predictable for the test: it ends at midnight UTC.
    await ws.owner.patch(`/v1/orgs/${ws.orgId}`, { timezone: 'UTC' });
    const now = new Date();
    const minutesToMidnight = Math.floor(
      (Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1) - now.getTime()) /
        60_000,
    );
    const a = await lead(ws, { name: 'Overdue One', ownerId: rep.userId });
    const b = await lead(ws, { name: 'Today Two', ownerId: rep.userId });
    const c = await lead(ws, { name: 'Quiet Three', ownerId: rep.userId });
    const d = await lead(ws, { name: 'Closed Four', ownerId: rep.userId, dealValue: 900 });
    const mk = (leadId: string, title: string, minutes: number) =>
      task(ws, { leadId, title, dueAt: inMinutes(minutes), assigneeId: rep.userId });
    await mk(a.id, 'Very late', -300);
    await mk(a.id, 'A bit late', -20);
    if (minutesToMidnight > 3) await mk(b.id, 'Later today', Math.min(minutesToMidnight - 2, 60));
    await mk(b.id, 'Tomorrow or later', minutesToMidnight + 120);
    await mk(d.id, 'On a closed lead', -60);
    await ws.owner.patch(`/v1/orgs/${ws.orgId}/leads/${d.id}`, { stageId: stage(ws, 'WON').id });
    await app.sql.query(`UPDATE "Lead" SET "slaDueAt" = now() - interval '2 hours' WHERE id = $1`, [
      c.id,
    ]);
    // Someone else's task never shows in the rep's day.
    await task(ws, { leadId: a.id, title: 'Owner task', dueAt: inMinutes(-5) });

    const day = await rep.client.get(`/v1/orgs/${ws.orgId}/me/day`);
    expect(day.status).toBe(200);
    expect(day.body.overdue.map((t: { title: string }) => t.title)).toEqual([
      'Very late',
      'A bit late',
    ]);
    expect(day.body.today.map((t: { title: string }) => t.title)).toEqual(
      minutesToMidnight > 3 ? ['Later today'] : [],
    );
    // Overdue One is stuck since its earliest overdue step, before Quiet Three went quiet.
    expect(day.body.stuck.map((l: { name: string }) => l.name)).toEqual([
      'Overdue One',
      'Quiet Three',
    ]);
  });
});

describe('NOT-01 notification centre', () => {
  it('NOT-01: the inviter is notified in-app when an invitation is accepted', async () => {
    const ws = await workspace('not01');
    await addMember(app, ws.owner, ws.orgId, 'MANAGER', 'not01-mgr');
    const count = await ws.owner.get(`/v1/orgs/${ws.orgId}/notifications/unread-count`);
    expect(count.body).toEqual({ unread: 1 });
    const list = await ws.owner.get(`/v1/orgs/${ws.orgId}/notifications`);
    expect(list.body.items[0]).toMatchObject({
      kind: 'MEMBER_JOINED',
      readAt: null,
      payload: { name: 'not01-mgr', role: 'MANAGER' },
    });
  });

  it('NOT-01: mark one or all as read; another member cannot touch yours', async () => {
    const ws = await workspace('not01r');
    const m1 = await addMember(app, ws.owner, ws.orgId, 'MANAGER', 'not01-a');
    await addMember(app, ws.owner, ws.orgId, 'MANAGER', 'not01-b');
    const list = await ws.owner.get(`/v1/orgs/${ws.orgId}/notifications`);
    expect(list.body.items).toHaveLength(2);
    const first = list.body.items[0].id;

    expect((await m1.client.post(`/v1/orgs/${ws.orgId}/notifications/${first}/read`)).status).toBe(
      404,
    );
    const one = await ws.owner.post(`/v1/orgs/${ws.orgId}/notifications/${first}/read`);
    expect(one.status).toBe(200);
    expect(one.body).toEqual({ unread: 1 });
    const unread = await ws.owner.get(`/v1/orgs/${ws.orgId}/notifications?unread=true`);
    expect(unread.body.items.map((n: { id: string }) => n.id)).not.toContain(first);

    const all = await ws.owner.post(`/v1/orgs/${ws.orgId}/notifications/read-all`);
    expect(all.body).toEqual({ unread: 0 });
    expect((await ws.owner.get(`/v1/orgs/${ws.orgId}/notifications/unread-count`)).body).toEqual({
      unread: 0,
    });
  });
});
