import type { FaultHook } from '@datoflow/worker';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  addMember,
  createOrg,
  inMinutes,
  Outbox,
  setPlan,
  signUp,
  startApp,
  startWorker,
  waitFor,
  type Client,
  type TestApp,
  type TestWorker,
} from './harness.js';

let app: TestApp;
let worker: TestWorker;
/** Fault hooks by workflow name, so each test breaks only its own workflow. */
const faults = new Map<string, FaultHook>();

beforeAll(async () => {
  app = await startApp();
  worker = await startWorker(
    app,
    {
      WORKFLOW_POLL_MS: '100',
      WORKFLOW_RETRY_BASE_MS: '50',
      WORKFLOW_SWEEP_SECONDS: '1',
      WORKFLOW_LEASE_SECONDS: '5',
    },
    new Outbox(),
    {
      faults: (step) => faults.get(step.workflowName)?.(step),
      random: () => 0.5,
    },
  );
});
afterAll(async () => {
  await worker.close();
  await app.close();
});

interface Ws {
  owner: Client;
  ownerId: string;
  ownerEmail: string;
  orgId: string;
  stages: { id: string; name: string; kind: string }[];
}

async function workspace(label: string, plan = 'agency', sample = false): Promise<Ws> {
  const owner = await signUp(app, label);
  const org = await createOrg(owner.client, label, { sample });
  await setPlan(app, org.id, plan);
  const pipelines = await owner.client.get(`/v1/orgs/${org.id}/pipelines`);
  return {
    owner: owner.client,
    ownerId: owner.userId,
    ownerEmail: owner.email,
    orgId: org.id,
    stages: pipelines.body.items[0].stages,
  };
}

async function flow(ws: Ws, name: string, definition: unknown, activate = true) {
  const res = await ws.owner.post(`/v1/orgs/${ws.orgId}/workflows`, { name, definition });
  if (res.status !== 201) throw new Error(`workflow: ${res.status} ${JSON.stringify(res.body)}`);
  if (activate) {
    const on = await ws.owner.post(`/v1/orgs/${ws.orgId}/workflows/${res.body.id}/activate`);
    if (on.status !== 200) throw new Error(`activate: ${on.status} ${JSON.stringify(on.body)}`);
  }
  return res.body as { id: string; versions: { id: string }[] };
}

async function lead(ws: Ws, body: Record<string, unknown> = {}) {
  const res = await ws.owner.post(`/v1/orgs/${ws.orgId}/leads`, { name: 'Amaya Perera', ...body });
  if (res.status !== 201) throw new Error(`lead: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body as { id: string; ownerId: string | null };
}

interface Run {
  id: string;
  status: string;
  skipReason: string | null;
  attempt: number;
  depth: number;
  eventType: string;
  leadId: string;
  error: string | null;
  errorKind: string | null;
}

const FINAL = ['SUCCEEDED', 'SKIPPED', 'CANCELLED', 'DEAD'];

async function runs(ws: Ws, workflowId: string): Promise<Run[]> {
  const res = await ws.owner.get(`/v1/orgs/${ws.orgId}/executions?workflowId=${workflowId}`);
  return res.body.items;
}

/** Waits until the workflow has `n` runs and all are finished. */
async function settled(ws: Ws, workflowId: string, n = 1, timeoutMs = 20_000) {
  return waitFor(
    async () => {
      const list = await runs(ws, workflowId);
      return list.length >= n && list.every((r) => FINAL.includes(r.status)) ? list : null;
    },
    `${n} finished runs`,
    timeoutMs,
  );
}

async function count(sql: string, params: unknown[]) {
  const { rows } = await app.sql.query(sql, params);
  return Number(rows[0].n);
}

const notifyOwner = { type: 'notify', to: 'owner', message: 'Call {{lead.name}}' };

describe('WF-01 builder and versions', () => {
  it('WF-01: saving creates an immutable version; the database refuses to change one', async () => {
    const ws = await workspace('wf01');
    const created = await flow(
      ws,
      'Versions',
      { trigger: 'lead.created', actions: [notifyOwner] },
      false,
    );
    expect(created).toMatchObject({ status: 'DRAFT', latestVersion: 1, activeVersion: null });

    const v2 = await ws.owner.post(`/v1/orgs/${ws.orgId}/workflows/${created.id}/versions`, {
      name: 'Versions renamed',
      definition: {
        trigger: 'lead.assigned',
        conditions: [{ field: 'priority', operator: 'is', values: ['HIGH'] }],
        actions: [notifyOwner, { type: 'update_field', field: 'tags', op: 'add', value: ['VIP'] }],
      },
    });
    expect(v2.status).toBe(201);
    expect(v2.body).toMatchObject({
      name: 'Versions renamed',
      latestVersion: 2,
      trigger: 'lead.assigned',
    });
    expect(v2.body.versions.map((v: { version: number }) => v.version)).toEqual([2, 1]);
    // Version 1 is exactly as it was saved.
    expect(v2.body.versions[1].definition).toEqual({
      trigger: 'lead.created',
      conditions: [],
      actions: [{ ...notifyOwner, userId: null }],
    });
    await expect(
      app.sql.query(`UPDATE "WorkflowVersion" SET trigger = 'lead.assigned' WHERE id = $1`, [
        created.versions[0]!.id,
      ]),
    ).rejects.toThrow(/immutable/);

    // An active workflow runs each new version from the moment it is saved.
    await ws.owner.post(`/v1/orgs/${ws.orgId}/workflows/${created.id}/activate`);
    const v3 = await ws.owner.post(`/v1/orgs/${ws.orgId}/workflows/${created.id}/versions`, {
      definition: { trigger: 'lead.created', actions: [notifyOwner] },
    });
    expect(v3.body).toMatchObject({ status: 'ACTIVE', latestVersion: 3, activeVersion: 3 });
    const audit = await ws.owner.get(`/v1/orgs/${ws.orgId}/audit-logs?limit=20`);
    expect(audit.body.items.map((e: { action: string }) => e.action)).toEqual(
      expect.arrayContaining(['workflow.created', 'workflow.version_saved', 'workflow.activated']),
    );
  });

  it('WF-01: one trigger, at most 10 actions; Sales Reps cannot manage workflows', async () => {
    const ws = await workspace('wf01-limits');
    const eleven = await ws.owner.post(`/v1/orgs/${ws.orgId}/workflows`, {
      name: 'Too many',
      definition: { trigger: 'lead.created', actions: Array(11).fill(notifyOwner) },
    });
    expect(eleven.status).toBe(422);
    expect(eleven.body.errors[0]).toMatchObject({ path: 'body.definition.actions' });
    const ten = await ws.owner.post(`/v1/orgs/${ws.orgId}/workflows`, {
      name: 'Ten',
      definition: { trigger: 'lead.created', actions: Array(10).fill(notifyOwner) },
    });
    expect(ten.status).toBe(201);
    const none = await ws.owner.post(`/v1/orgs/${ws.orgId}/workflows`, {
      name: 'None',
      definition: { trigger: 'lead.created', actions: [] },
    });
    expect(none.status).toBe(422);
    const unknownTrigger = await ws.owner.post(`/v1/orgs/${ws.orgId}/workflows`, {
      name: 'Bad',
      definition: { trigger: 'lead.deleted', actions: [notifyOwner] },
    });
    expect(unknownTrigger.status).toBe(422);

    const rep = await addMember(app, ws.owner, ws.orgId, 'REP', 'wf01-rep');
    expect((await rep.client.get(`/v1/orgs/${ws.orgId}/workflows`)).status).toBe(403);
    const manager = await addMember(app, ws.owner, ws.orgId, 'MANAGER', 'wf01-mgr');
    expect((await manager.client.get(`/v1/orgs/${ws.orgId}/workflows`)).status).toBe(200);
  });
});

describe('WF-02 triggers', () => {
  it('WF-02: lead.created starts a run', async () => {
    const ws = await workspace('wf02-created');
    const f = await flow(ws, 'On created', { trigger: 'lead.created', actions: [notifyOwner] });
    const l = await lead(ws);
    const [run] = await settled(ws, f.id);
    expect(run).toMatchObject({
      status: 'SUCCEEDED',
      eventType: 'lead.created',
      leadId: l.id,
      depth: 0,
    });
  });

  it('WF-02: lead.stage_changed starts a run', async () => {
    const ws = await workspace('wf02-stage');
    const f = await flow(ws, 'On stage', { trigger: 'lead.stage_changed', actions: [notifyOwner] });
    const l = await lead(ws);
    await ws.owner.patch(`/v1/orgs/${ws.orgId}/leads/${l.id}`, { stageId: ws.stages[1]!.id });
    const [run] = await settled(ws, f.id);
    expect(run).toMatchObject({ status: 'SUCCEEDED', eventType: 'lead.stage_changed' });
  });

  it('WF-02: lead.assigned starts a run', async () => {
    const ws = await workspace('wf02-assigned');
    const rep = await addMember(app, ws.owner, ws.orgId, 'REP', 'wf02-rep');
    const f = await flow(ws, 'On assigned', { trigger: 'lead.assigned', actions: [notifyOwner] });
    const l = await lead(ws);
    await ws.owner.patch(`/v1/orgs/${ws.orgId}/leads/${l.id}`, { ownerId: rep.userId });
    const [run] = await settled(ws, f.id);
    expect(run).toMatchObject({ status: 'SUCCEEDED', eventType: 'lead.assigned' });
    const inbox = await rep.client.get(`/v1/orgs/${ws.orgId}/notifications`);
    expect(inbox.body.items[0]).toMatchObject({
      kind: 'WORKFLOW_MESSAGE',
      payload: { message: 'Call Amaya Perera', workflowName: 'On assigned' },
    });
  });

  it('WF-02: task.deadline_reached starts a run once per due time', async () => {
    const ws = await workspace('wf02-deadline');
    const f = await flow(ws, 'On deadline', {
      trigger: 'task.deadline_reached',
      actions: [{ type: 'update_field', field: 'priority', value: 'HIGH' }],
    });
    const l = await lead(ws);
    const task = await ws.owner.post(`/v1/orgs/${ws.orgId}/tasks`, {
      leadId: l.id,
      title: 'Call back',
      type: 'CALL',
      dueAt: inMinutes(-1),
    });
    await worker.jobs.reminders();
    await worker.jobs.reminders();
    const [run] = await settled(ws, f.id);
    expect(run).toMatchObject({ status: 'SUCCEEDED', eventType: 'task.deadline_reached' });
    expect(
      await count(`SELECT count(*) AS n FROM "OutboxEvent" WHERE "aggregateId" = $1`, [
        task.body.id,
      ]),
    ).toBe(1);
    const updated = await ws.owner.get(`/v1/orgs/${ws.orgId}/leads/${l.id}`);
    expect(updated.body.priority).toBe('HIGH');
    // Moved to a new time, the step raises a new event when that time comes.
    await ws.owner.patch(`/v1/orgs/${ws.orgId}/tasks/${task.body.id}`, { dueAt: inMinutes(-0.5) });
    await worker.jobs.reminders();
    await settled(ws, f.id, 2);
  });
});

describe('WF-03 conditions', () => {
  it('WF-03: false conditions record a SKIPPED run; true ones run', async () => {
    const ws = await workspace('wf03');
    const f = await flow(ws, 'Website only', {
      trigger: 'lead.created',
      conditions: [
        { field: 'source', operator: 'is_any_of', values: ['WEBSITE', 'FORM'] },
        { field: 'priority', operator: 'is_none_of', values: ['LOW'] },
      ],
      actions: [{ type: 'update_field', field: 'tags', op: 'add', value: ['web'] }],
    });
    const referral = await lead(ws, { name: 'Referral lead', source: 'REFERRAL' });
    const lowWeb = await lead(ws, { name: 'Low web lead', source: 'WEBSITE', priority: 'LOW' });
    const web = await lead(ws, { name: 'Web lead', source: 'WEBSITE' });
    const list = await settled(ws, f.id, 3);
    const byLead = new Map(list.map((r) => [r.leadId, r]));
    expect(byLead.get(referral.id)).toMatchObject({
      status: 'SKIPPED',
      skipReason: 'CONDITIONS_NOT_MET',
    });
    expect(byLead.get(lowWeb.id)).toMatchObject({
      status: 'SKIPPED',
      skipReason: 'CONDITIONS_NOT_MET',
    });
    expect(byLead.get(web.id)).toMatchObject({ status: 'SUCCEEDED' });
    expect((await ws.owner.get(`/v1/orgs/${ws.orgId}/leads/${web.id}`)).body.tags).toEqual(['web']);
    expect((await ws.owner.get(`/v1/orgs/${ws.orgId}/leads/${referral.id}`)).body.tags).toEqual([]);
  });

  it('WF-03: assignee conditions match the owner, or the unassigned pool', async () => {
    const ws = await workspace('wf03-assignee');
    const f = await flow(ws, 'Pool only', {
      trigger: 'lead.created',
      conditions: [{ field: 'assignee', operator: 'is', values: ['unassigned'] }],
      actions: [{ type: 'notify', to: 'admins', message: 'Pool lead' }],
    });
    const pool = await lead(ws, { ownerId: null });
    const mine = await lead(ws);
    const list = await settled(ws, f.id, 2);
    expect(list.find((r) => r.leadId === pool.id)?.status).toBe('SUCCEEDED');
    expect(list.find((r) => r.leadId === mine.id)?.status).toBe('SKIPPED');
  });
});

describe('WF-04 actions', () => {
  it('WF-04: assign, create task, schedule email, notify and update fields, as "Workflow: name"', async () => {
    const ws = await workspace('wf04');
    const rep = await addMember(app, ws.owner, ws.orgId, 'REP', 'wf04-rep');
    const f = await flow(ws, 'Full welcome', {
      trigger: 'lead.created',
      actions: [
        { type: 'assign', mode: 'user', userIds: [rep.userId] },
        {
          type: 'create_task',
          title: 'First call',
          taskType: 'CALL',
          dueInHours: 4,
          priority: 'HIGH',
        },
        {
          type: 'send_email',
          to: 'lead',
          subject: 'Thanks, {{lead.name}}',
          body: 'Hi {{lead.name}}, {{owner.name}} will call you. {{org.name}}',
          delayMinutes: 0,
        },
        { type: 'notify', to: 'owner', message: 'New lead {{lead.name}}' },
        { type: 'update_field', field: 'priority', value: 'HIGH' },
        { type: 'update_field', field: 'stage', value: ws.stages[1]!.id },
        { type: 'update_field', field: 'tags', op: 'add', value: ['Welcome', 'vip'] },
      ],
    });
    const l = await lead(ws, { name: 'Kasun Silva', email: 'kasun@client.lk' });
    const [run] = await settled(ws, f.id);
    expect(run!.status).toBe('SUCCEEDED');

    const detail = await ws.owner.get(`/v1/orgs/${ws.orgId}/executions/${run!.id}`);
    expect(detail.body.steps.map((s: { status: string }) => s.status)).toEqual(
      Array(7).fill('SUCCEEDED'),
    );

    const got = (await ws.owner.get(`/v1/orgs/${ws.orgId}/leads/${l.id}`)).body;
    expect(got).toMatchObject({
      ownerId: rep.userId,
      priority: 'HIGH',
      stageId: ws.stages[1]!.id,
      tags: ['welcome', 'vip'],
    });
    const tasks = await ws.owner.get(`/v1/orgs/${ws.orgId}/tasks?leadId=${l.id}`);
    expect(tasks.body.items).toHaveLength(1);
    expect(tasks.body.items[0]).toMatchObject({
      title: 'First call',
      assigneeId: rep.userId,
      priority: 'HIGH',
    });
    expect(got.nextStepDueAt).not.toBeNull();

    // The email waits in the delivery queue, then goes out with the placeholders filled in.
    await worker.jobs.reminders();
    const mail = worker.outbox.last('kasun@client.lk');
    expect(mail.subject).toBe('Thanks, Kasun Silva');
    expect(mail.text).toContain(`Hi Kasun Silva, ${'wf04-rep'} will call you. wf04 Agency`);
    expect(mail.idempotencyKey).toBe(`wf:${run!.id}:2`);

    const inbox = await rep.client.get(`/v1/orgs/${ws.orgId}/notifications`);
    expect(
      inbox.body.items.map((n: { payload: { message: string } }) => n.payload.message),
    ).toContain('New lead Kasun Silva');

    const timeline = await ws.owner.get(`/v1/orgs/${ws.orgId}/leads/${l.id}/activities?limit=50`);
    const byWorkflow = timeline.body.items.filter(
      (a: { actor: { type: string } }) => a.actor.type === 'WORKFLOW',
    );
    expect(new Set(byWorkflow.map((a: { actor: { name: string } }) => a.actor.name))).toEqual(
      new Set(['Workflow: Full welcome']),
    );
    expect(byWorkflow.map((a: { type: string }) => a.type).sort()).toEqual(
      [
        'ASSIGNED',
        'STAGE_CHANGED',
        'TASK_CREATED',
        'UPDATED',
        'UPDATED',
        'WORKFLOW_ACTION',
        'WORKFLOW_ACTION',
      ].sort(),
    );
  });

  it('WF-04: round-robin assigns members in turn', async () => {
    const ws = await workspace('wf04-rr');
    const a = await addMember(app, ws.owner, ws.orgId, 'REP', 'wf04-rr-a');
    const b = await addMember(app, ws.owner, ws.orgId, 'REP', 'wf04-rr-b');
    const f = await flow(ws, 'Round robin', {
      trigger: 'lead.created',
      actions: [{ type: 'assign', mode: 'round_robin', userIds: [a.userId, b.userId] }],
    });
    const owners: string[] = [];
    for (const name of ['One', 'Two', 'Three']) {
      const l = await lead(ws, { name, ownerId: null });
      await settled(ws, f.id, owners.length + 1);
      owners.push((await ws.owner.get(`/v1/orgs/${ws.orgId}/leads/${l.id}`)).body.ownerId);
    }
    expect(owners).toEqual([a.userId, b.userId, a.userId]);
  });

  it('WF-04: fields outside the allow-list, closed stages and outsiders are refused on save', async () => {
    const ws = await workspace('wf04-allow');
    const save = (action: unknown) =>
      ws.owner.post(`/v1/orgs/${ws.orgId}/workflows`, {
        name: 'Refused',
        definition: { trigger: 'lead.created', actions: [action] },
      });
    for (const field of ['dealValue', 'email', 'name', 'source']) {
      expect((await save({ type: 'update_field', field, value: 'x' })).status).toBe(422);
    }
    const won = ws.stages.find((s) => s.kind === 'WON')!;
    const toWon = await save({ type: 'update_field', field: 'stage', value: won.id });
    expect(toWon.status).toBe(422);
    expect(toWon.body.errors[0].path).toBe('body.definition.actions.0.value');
    const stranger = await save({
      type: 'assign',
      mode: 'user',
      userIds: ['00000000-0000-4000-8000-000000000000'],
    });
    expect(stranger.status).toBe(422);
    const late = await save({
      type: 'send_email',
      to: 'lead',
      subject: 'x',
      body: 'y',
      delayMinutes: 43_201,
    });
    expect(late.status).toBe(422);
    const script = await save({ type: 'run_script', code: 'process.exit()' });
    expect(script.status).toBe(422);
  });
});

describe('WF-05 activate, pause, resume', () => {
  it('WF-05: pausing cancels queued runs; a paused workflow starts no new runs; resume restarts it', async () => {
    const ws = await workspace('wf05');
    const f = await flow(ws, 'Pausable', { trigger: 'lead.created', actions: [notifyOwner] });
    const l = await lead(ws);
    await settled(ws, f.id);
    // Two runs waiting: one queued, one failed with a retry due later.
    const { rows } = await app.sql.query(
      `INSERT INTO "WorkflowExecution" (id, "organizationId", "workflowId", "versionId", "eventId", "eventType", "leadId", status, "nextAttemptAt", attempt, "updatedAt")
       VALUES (gen_random_uuid()::text, $1, $2, $3, gen_random_uuid()::text, 'lead.created', $4, 'QUEUED', NULL, 0, now()),
              (gen_random_uuid()::text, $1, $2, $3, gen_random_uuid()::text, 'lead.created', $4, 'FAILED', now() + interval '1 hour', 1, now())
       RETURNING id`,
      [ws.orgId, f.id, f.versions[0]!.id, l.id],
    );
    const paused = await ws.owner.post(`/v1/orgs/${ws.orgId}/workflows/${f.id}/pause`);
    expect(paused.body.status).toBe('PAUSED');
    for (const r of rows) {
      const got = await ws.owner.get(`/v1/orgs/${ws.orgId}/executions/${r.id}`);
      expect(got.body.status).toBe('CANCELLED');
    }
    await lead(ws, { name: 'While paused' });
    await new Promise((r) => setTimeout(r, 1000));
    expect((await runs(ws, f.id)).filter((r) => r.status !== 'CANCELLED')).toHaveLength(1);

    const resumed = await ws.owner.post(`/v1/orgs/${ws.orgId}/workflows/${f.id}/activate`);
    expect(resumed.body.status).toBe('ACTIVE');
    await lead(ws, { name: 'After resume' });
    const list = await settled(ws, f.id, 4);
    expect(list.filter((r) => r.status === 'SUCCEEDED')).toHaveLength(2);
  });

  it('WF-05: a queued run picked up after its workflow was paused becomes CANCELLED', async () => {
    const ws = await workspace('wf05-late');
    const f = await flow(ws, 'Late pause', { trigger: 'lead.created', actions: [notifyOwner] });
    const l = await lead(ws);
    await settled(ws, f.id);
    await app.sql.query(`UPDATE "Workflow" SET status = 'PAUSED' WHERE id = $1`, [f.id]);
    const { rows } = await app.sql.query(
      `INSERT INTO "WorkflowExecution" (id, "organizationId", "workflowId", "versionId", "eventId", "eventType", "leadId", status, "updatedAt")
       VALUES (gen_random_uuid()::text, $1, $2, $3, gen_random_uuid()::text, 'lead.created', $4, 'QUEUED', now()) RETURNING id`,
      [ws.orgId, f.id, f.versions[0]!.id, l.id],
    );
    expect(await worker.jobs.run(rows[0].id)).toEqual({ status: 'CANCELLED' });
  });

  it("WF-05: activating checks the plan's active-workflow limit; sample workflows do not count", async () => {
    const ws = await workspace('wf05-limit', 'free', true);
    const sample = await ws.owner.get(`/v1/orgs/${ws.orgId}/workflows`);
    expect(
      sample.body.items.filter(
        (w: { isSample: boolean; status: string }) => w.isSample && w.status === 'ACTIVE',
      ),
    ).toHaveLength(2);
    const first = await flow(ws, 'First', { trigger: 'lead.created', actions: [notifyOwner] });
    const second = await flow(
      ws,
      'Second',
      { trigger: 'lead.created', actions: [notifyOwner] },
      false,
    );
    const refused = await ws.owner.post(`/v1/orgs/${ws.orgId}/workflows/${second.id}/activate`);
    expect(refused.status).toBe(402);
    expect(refused.body).toMatchObject({ code: 'PLAN_LIMIT_REACHED', limit: 'activeWorkflows' });
    await ws.owner.post(`/v1/orgs/${ws.orgId}/workflows/${first.id}/pause`);
    expect(
      (await ws.owner.post(`/v1/orgs/${ws.orgId}/workflows/${second.id}/activate`)).status,
    ).toBe(200);
  });
});

describe('WF-06 execution log', () => {
  it('WF-06: the log shows status, attempts, steps and errors; retry only FAILED or DEAD runs', async () => {
    const ws = await workspace('wf06');
    const f = await flow(ws, 'Email the lead', {
      trigger: 'lead.created',
      actions: [
        {
          type: 'create_task',
          title: 'Prepare',
          taskType: 'OTHER',
          dueInHours: 1,
          priority: 'NORMAL',
        },
        {
          type: 'send_email',
          to: 'lead',
          subject: 'Hello',
          body: 'Hi {{lead.name}}',
          delayMinutes: 60,
        },
      ],
    });
    const l = await lead(ws, { name: 'No address' });
    const [dead] = await settled(ws, f.id);
    expect(dead).toMatchObject({ status: 'DEAD', attempt: 1, errorKind: 'VALIDATION' });
    expect(dead!.error).toBe('Step 2 (send_email): The lead has no email address');

    const filtered = await ws.owner.get(`/v1/orgs/${ws.orgId}/executions?status=DEAD`);
    expect(filtered.body.items.map((r: Run) => r.id)).toEqual([dead!.id]);
    const detail = await ws.owner.get(`/v1/orgs/${ws.orgId}/executions/${dead!.id}`);
    expect(detail.body).toMatchObject({
      canRetry: true,
      steps: [
        { stepIndex: 0, status: 'SUCCEEDED', attempt: 1 },
        { stepIndex: 1, status: 'FAILED', attempt: 1, error: 'The lead has no email address' },
      ],
    });

    // Fix the cause, then retry: the step that succeeded is not repeated.
    await ws.owner.patch(`/v1/orgs/${ws.orgId}/leads/${l.id}`, { email: 'fixed@client.lk' });
    const retried = await ws.owner.post(`/v1/orgs/${ws.orgId}/executions/${dead!.id}/retry`);
    expect(retried.status).toBe(200);
    expect(retried.body).toMatchObject({ status: 'QUEUED', manualRetries: 1 });
    const [done] = await settled(ws, f.id);
    expect(done).toMatchObject({ status: 'SUCCEEDED', attempt: 1 });
    expect(
      (await ws.owner.get(`/v1/orgs/${ws.orgId}/tasks?leadId=${l.id}`)).body.items,
    ).toHaveLength(1);
    expect(
      await count(
        `SELECT count(*) AS n FROM "Notification" WHERE "toAddress" = 'fixed@client.lk'`,
        [],
      ),
    ).toBe(1);

    const again = await ws.owner.post(`/v1/orgs/${ws.orgId}/executions/${dead!.id}/retry`);
    expect(again.status).toBe(409);
    expect(again.body.detail).toBe('Only failed or dead runs can be retried');
    const audit = await ws.owner.get(`/v1/orgs/${ws.orgId}/audit-logs?limit=5`);
    expect(audit.body.items[0].action).toBe('workflow.run_retried');
  });

  it('WF-06: a run of a paused workflow cannot be retried until it is resumed', async () => {
    const ws = await workspace('wf06-paused');
    const f = await flow(ws, 'Paused retry', {
      trigger: 'lead.created',
      actions: [{ type: 'send_email', to: 'lead', subject: 'Hi', body: 'Hi', delayMinutes: 0 }],
    });
    await lead(ws);
    const [dead] = await settled(ws, f.id);
    await ws.owner.post(`/v1/orgs/${ws.orgId}/workflows/${f.id}/pause`);
    const res = await ws.owner.post(`/v1/orgs/${ws.orgId}/executions/${dead!.id}/retry`);
    expect(res.status).toBe(409);
    expect(res.body.detail).toBe('Resume the workflow before retrying its runs');
  });
});

describe('WF-07 idempotency', () => {
  it('WF-07: a replayed event creates no second execution and no second side effect', async () => {
    const ws = await workspace('wf07');
    const f = await flow(ws, 'Replay', {
      trigger: 'lead.created',
      actions: [
        { type: 'create_task', title: 'Once', taskType: 'CALL', dueInHours: 2, priority: 'NORMAL' },
      ],
    });
    const l = await lead(ws);
    const [run] = await settled(ws, f.id);
    const { rows } = await app.sql.query(
      `SELECT id FROM "OutboxEvent" WHERE "aggregateId" = $1 AND type = 'lead.created'`,
      [l.id],
    );
    const eventId = rows[0].id as string;

    // Dispatched again directly, and published again through the queue.
    expect(await worker.jobs.dispatch(eventId)).toEqual([]);
    await app.sql.query(`UPDATE "OutboxEvent" SET "publishedAt" = NULL WHERE id = $1`, [eventId]);
    await waitFor(
      async () =>
        (await app.sql.query(`SELECT "publishedAt" FROM "OutboxEvent" WHERE id = $1`, [eventId]))
          .rows[0].publishedAt,
      'republish',
    );
    await new Promise((r) => setTimeout(r, 500));
    expect(
      await count(`SELECT count(*) AS n FROM "WorkflowExecution" WHERE "eventId" = $1`, [eventId]),
    ).toBe(1);
    // Running the finished execution again does nothing.
    expect(await worker.jobs.run(run!.id)).toEqual({ status: 'NOT_CLAIMED' });
    expect(await count(`SELECT count(*) AS n FROM "Task" WHERE "leadId" = $1`, [l.id])).toBe(1);
  });

  it('WF-07: a step that committed is not repeated when a later step fails and the run retries', async () => {
    const ws = await workspace('wf07-steps');
    const f = await flow(ws, 'Retry later step', {
      trigger: 'lead.created',
      actions: [
        {
          type: 'create_task',
          title: 'Only one',
          taskType: 'CALL',
          dueInHours: 2,
          priority: 'NORMAL',
        },
        notifyOwner,
      ],
    });
    faults.set('Retry later step', ({ stepIndex, attempt }) => {
      if (stepIndex === 1 && attempt === 1) throw new Error('connection reset');
    });
    const l = await lead(ws);
    const [run] = await settled(ws, f.id);
    expect(run).toMatchObject({ status: 'SUCCEEDED', attempt: 2 });
    const detail = await ws.owner.get(`/v1/orgs/${ws.orgId}/executions/${run!.id}`);
    expect(detail.body.steps.map((s: { attempt: number }) => s.attempt)).toEqual([1, 2]);
    expect(await count(`SELECT count(*) AS n FROM "Task" WHERE "leadId" = $1`, [l.id])).toBe(1);
    expect(
      await count(`SELECT count(*) AS n FROM "Notification" WHERE "dedupeKey" LIKE $1`, [
        `wf:${run!.id}:1:%`,
      ]),
    ).toBe(1);
  });
});

describe('WF-08 retries and dead runs', () => {
  it('WF-08: a transient failure is retried with backoff and then succeeds', async () => {
    const ws = await workspace('wf08-transient');
    const f = await flow(ws, 'Flaky', { trigger: 'lead.created', actions: [notifyOwner] });
    faults.set('Flaky', ({ attempt }) => {
      if (attempt <= 2) throw new Error('timeout');
    });
    await lead(ws);
    const [run] = await settled(ws, f.id);
    expect(run).toMatchObject({ status: 'SUCCEEDED', attempt: 3 });
  });

  it('WF-08: after the 5th failed attempt the run is DEAD and Owners and Admins are notified', async () => {
    const ws = await workspace('wf08-dead');
    const admin = await addMember(app, ws.owner, ws.orgId, 'ADMIN', 'wf08-admin');
    const rep = await addMember(app, ws.owner, ws.orgId, 'REP', 'wf08-rep');
    const f = await flow(ws, 'Always down', { trigger: 'lead.created', actions: [notifyOwner] });
    faults.set('Always down', () => {
      throw new Error('provider unavailable');
    });
    const l = await lead(ws, { name: 'Dilini Fernando' });
    const [run] = await settled(ws, f.id, 1, 30_000);
    expect(run).toMatchObject({ status: 'DEAD', attempt: 5, errorKind: 'TRANSIENT' });
    for (const who of [ws.owner, admin.client]) {
      const inbox = await who.get(`/v1/orgs/${ws.orgId}/notifications`);
      expect(
        inbox.body.items.find((n: { kind: string }) => n.kind === 'WORKFLOW_DEAD'),
      ).toMatchObject({
        payload: {
          executionId: run!.id,
          workflowName: 'Always down',
          leadId: l.id,
          leadName: 'Dilini Fernando',
        },
      });
    }
    const repInbox = await rep.client.get(`/v1/orgs/${ws.orgId}/notifications`);
    expect(repInbox.body.items.some((n: { kind: string }) => n.kind === 'WORKFLOW_DEAD')).toBe(
      false,
    );
  });

  it('WF-08: validation and permission errors fail fast without retries', async () => {
    const ws = await workspace('wf08-fast');
    const rep = await addMember(app, ws.owner, ws.orgId, 'REP', 'wf08-gone');
    const f = await flow(ws, 'Fail fast', {
      trigger: 'lead.created',
      actions: [{ type: 'assign', mode: 'user', userIds: [rep.userId] }],
    });
    // The member leaves after the workflow was saved.
    await ws.owner.delete(`/v1/orgs/${ws.orgId}/members/${rep.membershipId}`);
    await lead(ws);
    const [run] = await settled(ws, f.id);
    expect(run).toMatchObject({ status: 'DEAD', attempt: 1, errorKind: 'VALIDATION' });
    expect(run!.error).toContain('no longer a member');
  });
});

describe('WF-09 loop protection', () => {
  it('WF-09: events nest up to depth 3; deeper ones are SKIPPED', async () => {
    const ws = await workspace('wf09-depth');
    const f = await flow(ws, 'Deep', { trigger: 'lead.created', actions: [notifyOwner] });
    const l = await lead(ws);
    await settled(ws, f.id);
    for (const depth of [3, 4]) {
      await app.sql.query(
        `INSERT INTO "OutboxEvent" (id, "organizationId", type, "aggregateType", "aggregateId", payload, depth)
         VALUES (gen_random_uuid()::text, $1, 'lead.created', 'Lead', $2, '{"isSample": false}', $3)`,
        [ws.orgId, l.id, depth],
      );
    }
    const list = await settled(ws, f.id, 3);
    expect(list.map((r) => `${r.depth}:${r.status}:${r.skipReason ?? ''}`).sort()).toEqual([
      '0:SUCCEEDED:',
      '3:SUCCEEDED:',
      '4:SKIPPED:DEPTH_LIMIT',
    ]);
  });

  it("WF-09: a chain of workflows carries depth, and a workflow never runs on its own action's event", async () => {
    const ws = await workspace('wf09-chain');
    const rep = await addMember(app, ws.owner, ws.orgId, 'REP', 'wf09-rep');
    const assign = await flow(ws, 'Assign new', {
      trigger: 'lead.created',
      actions: [{ type: 'assign', mode: 'user', userIds: [rep.userId] }],
    });
    // Reacts to assignments, and reassigns: its own event must not start it again.
    const bounce = await flow(ws, 'Bounce', {
      trigger: 'lead.assigned',
      actions: [
        { type: 'update_field', field: 'owner', value: ws.ownerId },
        { type: 'update_field', field: 'stage', value: ws.stages[2]!.id },
      ],
    });
    const staged = await flow(ws, 'On stage', {
      trigger: 'lead.stage_changed',
      actions: [{ type: 'update_field', field: 'priority', value: 'HIGH' }],
    });
    const l = await lead(ws, { ownerId: null });
    const [first] = await settled(ws, assign.id);
    expect(first).toMatchObject({ depth: 0, status: 'SUCCEEDED' });
    const bounces = await settled(ws, bounce.id, 2);
    expect(bounces.map((r) => `${r.depth}:${r.status}:${r.skipReason ?? ''}`).sort()).toEqual([
      '1:SUCCEEDED:',
      '2:SKIPPED:SELF_TRIGGER',
    ]);
    const [last] = await settled(ws, staged.id);
    expect(last).toMatchObject({ depth: 2, status: 'SUCCEEDED' });
    const got = (await ws.owner.get(`/v1/orgs/${ws.orgId}/leads/${l.id}`)).body;
    expect(got).toMatchObject({ ownerId: ws.ownerId, priority: 'HIGH', stageId: ws.stages[2]!.id });
  });

  it("WF-09: over the plan's monthly run cap, runs are SKIPPED with the reason", async () => {
    const ws = await workspace('wf09-cap', 'free');
    const f = await flow(ws, 'Capped', { trigger: 'lead.created', actions: [notifyOwner] });
    const l = await lead(ws);
    await settled(ws, f.id);
    // 499 more runs this month: 500 in all, the Free plan's cap.
    await app.sql.query(
      `INSERT INTO "WorkflowExecution" (id, "organizationId", "workflowId", "versionId", "eventId", "eventType", "leadId", status, "updatedAt")
       SELECT gen_random_uuid()::text, $1, $2, $3, gen_random_uuid()::text, 'lead.created', $4, 'SUCCEEDED', now()
       FROM generate_series(1, 499)`,
      [ws.orgId, f.id, f.versions[0]!.id, l.id],
    );
    const over = await lead(ws, { name: 'Over the cap' });
    await waitFor(
      async () => (await runs(ws, f.id)).find((r) => r.leadId === over.id),
      'capped run',
    );
    const capped = (await runs(ws, f.id)).find((r) => r.leadId === over.id)!;
    expect(capped).toMatchObject({ status: 'SKIPPED', skipReason: 'PLAN_LIMIT' });
  });
});
