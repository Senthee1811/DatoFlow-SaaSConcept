/**
 * NFR-REL-01 kill-the-worker test. The real worker runs as its own process (the production build)
 * and is killed with SIGKILL in the middle of workflow runs: no shutdown hooks, no cleanup. A new
 * worker process must finish every run, with every side effect exactly once.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createOrg, setPlan, signUp, startApp, waitFor, type TestApp } from './harness.js';

const WORKER_MAIN = join(import.meta.dirname, '..', '..', 'apps', 'worker', 'dist', 'main.js');
const LEADS = 30;
const STEPS = 10;

let app: TestApp;
const children: ChildProcess[] = [];

function startWorkerProcess(): ChildProcess {
  const child = spawn(process.execPath, [WORKER_MAIN], {
    env: {
      ...process.env,
      NODE_ENV: 'test',
      DATABASE_URL: app.env.DATABASE_URL,
      REDIS_URL: app.env.REDIS_URL,
      BETTER_AUTH_SECRET: app.env.BETTER_AUTH_SECRET,
      SECRETS_ENCRYPTION_KEY: app.env.SECRETS_ENCRYPTION_KEY,
      EMAIL_PROVIDER: 'console',
      WORKER_PORT: '0',
      RADAR_INTERVAL_SECONDS: '3600',
      REMINDER_INTERVAL_SECONDS: '3600',
      WORKFLOW_POLL_MS: '100',
      WORKFLOW_SWEEP_SECONDS: '1',
      // A run not heard from for 2 seconds belongs to a worker that stopped.
      WORKFLOW_LEASE_SECONDS: '2',
      WORKFLOW_RETRY_BASE_MS: '100',
      WORKFLOW_CONCURRENCY: '5',
    },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  child.stderr?.on('data', (d: Buffer) => process.stderr.write(`[worker] ${d}`));
  children.push(child);
  return child;
}

async function scalar(sql: string, params: unknown[] = []): Promise<number> {
  const { rows } = await app.sql.query(sql, params);
  return Number(rows[0].n);
}

beforeAll(async () => {
  app = await startApp();
});
afterAll(async () => {
  for (const c of children) if (c.exitCode === null) c.kill('SIGKILL');
  await app.close();
});

describe('NFR-REL-01 kill the worker', () => {
  it('NFR-REL-01: a worker killed mid-run is replaced and every run finishes with each side effect once', async () => {
    const owner = await signUp(app, 'kill');
    const org = await createOrg(owner.client, 'kill');
    await setPlan(app, org.id, 'agency');
    const actions = Array.from({ length: STEPS }, (_, i) =>
      i % 2 === 0
        ? {
            type: 'create_task',
            title: `Step ${i + 1}`,
            taskType: 'CALL',
            dueInHours: 24,
            priority: 'NORMAL',
          }
        : { type: 'notify', to: 'owner', message: `Step ${i + 1} for {{lead.name}}` },
    );
    const flow = await owner.client.post(`/v1/orgs/${org.id}/workflows`, {
      name: 'Ten steps',
      definition: { trigger: 'lead.created', actions },
    });
    expect(flow.status).toBe(201);
    await owner.client.post(`/v1/orgs/${org.id}/workflows/${flow.body.id}/activate`);
    for (let i = 0; i < LEADS; i += 1) {
      const res = await owner.client.post(`/v1/orgs/${org.id}/leads`, { name: `Kill lead ${i}` });
      expect(res.status).toBe(201);
    }

    const done = () =>
      scalar(
        `SELECT count(*) AS n FROM "WorkflowExecutionStep" WHERE "organizationId" = $1 AND status = 'SUCCEEDED'`,
        [org.id],
      );

    // The first worker starts on the runs and is killed partway through.
    const first = startWorkerProcess();
    await waitFor(async () => (await done()) >= 40, 'the first steps', 60_000);
    first.kill('SIGKILL');
    await new Promise<void>((resolve) => first.once('exit', () => resolve()));
    const atKill = await app.sql.query(
      `SELECT id, status FROM "WorkflowExecution" WHERE "workflowId" = $1`,
      [flow.body.id],
    );
    const unfinished = atKill.rows.filter((r) => r.status !== 'SUCCEEDED');
    const running = atKill.rows.filter((r) => r.status === 'RUNNING').map((r) => r.id as string);
    expect(unfinished.length, 'the kill must land before the work is done').toBeGreaterThan(0);
    expect(await done()).toBeLessThan(LEADS * STEPS);

    // A new worker takes over: interrupted runs are recovered after their lease, the rest resume.
    startWorkerProcess();
    await waitFor(
      async () =>
        (await scalar(
          `SELECT count(*) AS n FROM "WorkflowExecution" WHERE "workflowId" = $1 AND status = 'SUCCEEDED'`,
          [flow.body.id],
        )) === LEADS,
      'every run to succeed',
      90_000,
    );

    expect(
      await scalar(`SELECT count(*) AS n FROM "WorkflowExecution" WHERE "workflowId" = $1`, [
        flow.body.id,
      ]),
    ).toBe(LEADS);
    expect(await done()).toBe(LEADS * STEPS);
    // Exactly one task per create_task step and one notification per notify step, on every lead.
    const perLead = await app.sql.query(
      `SELECT l.id,
              (SELECT count(*) FROM "Task" t WHERE t."leadId" = l.id)::int AS tasks,
              (SELECT count(*) FROM "Notification" n
                 WHERE n."organizationId" = l."organizationId" AND n.kind = 'WORKFLOW_MESSAGE'
                   AND n.payload->>'leadId' = l.id)::int AS notes
       FROM "Lead" l WHERE l."organizationId" = $1`,
      [org.id],
    );
    expect(perLead.rows).toHaveLength(LEADS);
    for (const row of perLead.rows) {
      expect(row, `lead ${row.id}`).toMatchObject({ tasks: STEPS / 2, notes: STEPS / 2 });
    }
    // Runs that were mid-attempt when the worker died needed a second attempt.
    if (running.length) {
      const { rows } = await app.sql.query(
        `SELECT attempt FROM "WorkflowExecution" WHERE id = ANY($1::text[])`,
        [running],
      );
      expect(rows.every((r) => r.attempt >= 2)).toBe(true);
    }
  }, 180_000);
});
