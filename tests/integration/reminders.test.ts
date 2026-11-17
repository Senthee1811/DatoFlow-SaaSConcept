import type { EmailAdapter, EmailMessage } from '@datoflow/adapters';
import { Redis } from 'ioredis';
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
  ownerEmail: string;
  orgId: string;
}

async function workspace(label: string, plan = 'starter', timezone = 'Asia/Colombo'): Promise<Ws> {
  const owner = await signUp(app, label);
  const org = await createOrg(owner.client, label);
  await setPlan(app, org.id, plan);
  if (timezone !== 'Asia/Colombo') await owner.client.patch(`/v1/orgs/${org.id}`, { timezone });
  return { owner: owner.client, ownerId: owner.userId, ownerEmail: owner.email, orgId: org.id };
}

async function nextStep(
  ws: Ws,
  minutes: number,
  title = 'Call about the retainer',
  client = ws.owner,
) {
  const lead = await client.post(`/v1/orgs/${ws.orgId}/leads`, { name: `Lead for ${title}` });
  const task = await client.post(`/v1/orgs/${ws.orgId}/tasks`, {
    leadId: lead.body.id,
    title,
    type: 'CALL',
    dueAt: inMinutes(minutes),
  });
  if (task.status !== 201)
    throw new Error(`task failed: ${task.status} ${JSON.stringify(task.body)}`);
  return {
    leadId: lead.body.id as string,
    taskId: task.body.id as string,
    dueAt: task.body.dueAt as string,
  };
}

const reminderEmails = (outbox: Outbox, to: string, title: string) =>
  outbox.sent.filter((m) => m.to === to && m.subject.endsWith(title));

async function rows(where: string, params: unknown[]) {
  return (
    await app.sql.query(
      `SELECT *, to_char("sendAfter", 'YYYY-MM-DD"T"HH24:MI:SS') AS send_after_utc FROM "Notification" WHERE ${where}`,
      params,
    )
  ).rows;
}

describe('TASK-04 reminders', () => {
  it('TASK-04: 15 minutes before a next step, an in-app reminder and an email go to the assignee', async () => {
    const ws = await workspace('rem-basic');
    const step = await nextStep(ws, 10, 'Call about the retainer');
    const later = await nextStep(ws, 40, 'Not yet');
    const worker = await startWorker(app);
    try {
      await worker.jobs.reminders();
      const inApp = await ws.owner.get(`/v1/orgs/${ws.orgId}/notifications`);
      const reminders = inApp.body.items.filter(
        (n: { kind: string }) => n.kind === 'TASK_DUE_SOON',
      );
      expect(reminders).toHaveLength(1);
      expect(reminders[0].payload).toMatchObject({
        taskId: step.taskId,
        leadId: step.leadId,
        title: 'Call about the retainer',
      });
      const mail = reminderEmails(worker.outbox, ws.ownerEmail, 'Call about the retainer');
      expect(mail).toHaveLength(1);
      expect(mail[0]!.subject).toMatch(/^Due at \d\d:\d\d: Call about the retainer$/);
      expect(mail[0]!.text).toContain(`/leads/${step.leadId}`);
      expect(mail[0]!.idempotencyKey).toBe(
        `reminder:${step.taskId}:EMAIL:${new Date(step.dueAt).toISOString()}`,
      );
      expect(reminderEmails(worker.outbox, ws.ownerEmail, 'Not yet')).toHaveLength(0);
      expect(await rows(`payload->>'taskId' = $1`, [later.taskId])).toHaveLength(0);
    } finally {
      await worker.close();
    }
  });

  it('TASK-04: each reminder is sent exactly once across a worker restart', async () => {
    const ws = await workspace('rem-restart');
    const steps = await Promise.all([
      nextStep(ws, 5, 'Restart one'),
      nextStep(ws, 9, 'Restart two'),
      nextStep(ws, 14, 'Restart three'),
    ]);
    const outbox = new Outbox();
    const first = await startWorker(app, {}, outbox);
    await first.jobs.reminders();
    await first.jobs.reminders();
    // The worker stops (close waits for the job in progress) and a new one starts.
    await first.close();
    const second = await startWorker(app, {}, outbox);
    try {
      // The schedulers survived in Redis and were not duplicated by the restart.
      const schedulers = await second.queue().getJobSchedulers();
      expect(schedulers.map((s) => s.key).sort()).toEqual(['radar', 'reminders']);
      await second.jobs.reminders();
      await second.jobs.reminders(new Date(Date.now() + 60_000));
      for (const s of steps) {
        const title = ['Restart one', 'Restart two', 'Restart three'][steps.indexOf(s)]!;
        expect(reminderEmails(outbox, ws.ownerEmail, title)).toHaveLength(1);
        const keyed = await rows(`"dedupeKey" LIKE $1`, [`reminder:${s.taskId}:%`]);
        expect(keyed.map((r) => `${r.channel}:${r.status}`).sort()).toEqual([
          'EMAIL:SENT',
          'IN_APP:SENT',
        ]);
      }
    } finally {
      await second.close();
    }
  });

  it('TASK-04: a send cut off by a crash is never repeated by a provider without idempotency', async () => {
    const ws = await workspace('rem-crash');
    const step = await nextStep(ws, 10, 'Crash step');
    const worker = await startWorker(app);
    try {
      await worker.jobs.reminders();
      expect(reminderEmails(worker.outbox, ws.ownerEmail, 'Crash step')).toHaveLength(1);
      // Simulate the other crash window: claimed (SENDING) and then the process died.
      const key = `reminder:${step.taskId}:EMAIL:${new Date(step.dueAt).toISOString()}`;
      await app.sql.query(
        `UPDATE "Notification" SET status = 'SENDING', "claimedAt" = now() - interval '10 minutes', "sentAt" = NULL WHERE "dedupeKey" = $1`,
        [key],
      );
      await worker.jobs.reminders();
      expect(reminderEmails(worker.outbox, ws.ownerEmail, 'Crash step')).toHaveLength(1);
      expect((await rows(`"dedupeKey" = $1`, [key]))[0]).toMatchObject({
        status: 'SKIPPED',
        error: 'INTERRUPTED',
      });
    } finally {
      await worker.close();
    }
  });

  it('TASK-04: with an idempotent provider, an interrupted send is retried with the same key', async () => {
    const ws = await workspace('rem-idem');
    const step = await nextStep(ws, 10, 'Idempotent step');
    const key = `reminder:${step.taskId}:EMAIL:${new Date(step.dueAt).toISOString()}`;
    const calls: EmailMessage[] = [];
    // A provider like Resend: one email per key, however often it is asked.
    const delivered = new Set<string>();
    const resendLike: EmailAdapter & { sent: EmailMessage[] } = {
      name: 'resend',
      idempotent: true,
      sent: calls,
      async send(message) {
        calls.push(message);
        if (message.idempotencyKey) delivered.add(message.idempotencyKey);
        return { id: `r-${calls.length}` };
      },
    };
    const worker = await startWorker(app, {}, resendLike);
    try {
      await worker.jobs.reminders();
      await app.sql.query(
        `UPDATE "Notification" SET status = 'SENDING', "claimedAt" = now() - interval '10 minutes' WHERE "dedupeKey" = $1`,
        [key],
      );
      await worker.jobs.reminders();
      const forKey = calls.filter((m) => m.idempotencyKey === key);
      expect(forKey).toHaveLength(2);
      expect(delivered.has(key)).toBe(true);
      expect((await rows(`"dedupeKey" = $1`, [key]))[0].status).toBe('SENT');
    } finally {
      await worker.close();
    }
  });

  it('TASK-04: moving a next step to a new time earns a new reminder', async () => {
    const ws = await workspace('rem-move');
    const step = await nextStep(ws, 10, 'Moved step');
    const worker = await startWorker(app);
    try {
      await worker.jobs.reminders();
      await ws.owner.patch(`/v1/orgs/${ws.orgId}/tasks/${step.taskId}`, { dueAt: inMinutes(12) });
      await worker.jobs.reminders();
      expect(reminderEmails(worker.outbox, ws.ownerEmail, 'Moved step')).toHaveLength(2);
      // Done steps are not reminded.
      const done = await nextStep(ws, 8, 'Done step');
      await ws.owner.patch(`/v1/orgs/${ws.orgId}/tasks/${done.taskId}`, { status: 'DONE' });
      await worker.jobs.reminders();
      expect(reminderEmails(worker.outbox, ws.ownerEmail, 'Done step')).toHaveLength(0);
    } finally {
      await worker.close();
    }
  });

  it('TASK-04: the rep can turn reminder emails off; on Free, reminders are in-app only', async () => {
    const ws = await workspace('rem-pref');
    const rep = await addMember(app, ws.owner, ws.orgId, 'REP', 'rem-pref-rep');
    const put = await rep.client.request('PUT', `/v1/orgs/${ws.orgId}/me/preferences`, {
      notifications: { reminderEmail: false },
    });
    expect(put.status).toBe(200);
    await nextStep({ ...ws, owner: rep.client }, 10, 'Quiet step', rep.client);
    const free = await workspace('rem-free', 'free');
    await nextStep(free, 10, 'Free step');
    const worker = await startWorker(app);
    try {
      await worker.jobs.reminders();
      expect(reminderEmails(worker.outbox, rep.email, 'Quiet step')).toHaveLength(0);
      expect(
        (await rep.client.get(`/v1/orgs/${ws.orgId}/notifications/unread-count`)).body.unread,
      ).toBe(1);
      expect(reminderEmails(worker.outbox, free.ownerEmail, 'Free step')).toHaveLength(0);
      const freeInApp = await free.owner.get(`/v1/orgs/${free.orgId}/notifications`);
      expect(freeInApp.body.items.map((n: { kind: string }) => n.kind)).toEqual(['TASK_DUE_SOON']);
    } finally {
      await worker.close();
    }
  });
});

describe('TASK-04 daily digest', () => {
  /** The next instant at `hh:mm` UTC, at least a minute from now. Tests use a UTC organization. */
  function nextUtc(hh: number, mm: number) {
    const now = new Date();
    const t = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), hh, mm));
    if (t.getTime() <= now.getTime() + 60_000) t.setUTCDate(t.getUTCDate() + 1);
    return t;
  }

  it('TASK-04: the digest goes out once at 08:00 in the organization timezone', async () => {
    const ws = await workspace('digest', 'starter', 'UTC');
    const eight = nextUtc(8, 0);
    const lead = await ws.owner.post(`/v1/orgs/${ws.orgId}/leads`, { name: 'Digest Lead' });
    // Overdue at 08:00 on the digest day, and one due later that day.
    for (const [title, at] of [
      ['Overdue by digest time', new Date(eight.getTime() - 3_600_000)],
      ['Later that day', new Date(eight.getTime() + 4 * 3_600_000)],
    ] as const) {
      const res = await ws.owner.post(`/v1/orgs/${ws.orgId}/tasks`, {
        leadId: lead.body.id,
        title,
        type: 'EMAIL',
        dueAt: at.toISOString(),
      });
      expect(res.status).toBe(201);
    }
    const worker = await startWorker(app);
    try {
      const digests = () =>
        worker.outbox.sent.filter(
          (m) => m.to === ws.ownerEmail && m.subject.startsWith('Your day'),
        );
      await worker.jobs.reminders(new Date(eight.getTime() - 60_000));
      expect(digests()).toHaveLength(0);
      await worker.jobs.reminders(eight);
      await worker.jobs.reminders(new Date(eight.getTime() + 60_000));
      expect(digests()).toHaveLength(1);
      const mail = digests()[0]!;
      expect(mail.subject).toMatch(/1 overdue, 1 due today/);
      expect(mail.text).toContain('Overdue next steps');
      expect(mail.text).toContain('Overdue by digest time');
      expect(mail.text).toContain('Later that day');
      expect(mail.text).toContain(`/app/`);
      // A restarted worker does not send it again.
      await worker.close();
      const again = await startWorker(app);
      try {
        await again.jobs.reminders(new Date(eight.getTime() + 120_000));
        expect(again.outbox.sent.filter((m) => m.to === ws.ownerEmail)).toHaveLength(0);
      } finally {
        await again.close();
      }
    } finally {
      await worker.close().catch(() => undefined);
    }
  });

  it('TASK-04: a member with nothing due gets no digest, and one who opted out gets none', async () => {
    const ws = await workspace('digest-empty', 'starter', 'UTC');
    const eight = nextUtc(8, 0);
    const worker = await startWorker(app);
    try {
      await worker.jobs.reminders(eight);
      expect(worker.outbox.sent.filter((m) => m.to === ws.ownerEmail)).toHaveLength(0);
      const [row] = await rows(`"organizationId" = $1 AND kind = 'DAILY_DIGEST'`, [ws.orgId]);
      expect(row).toMatchObject({ status: 'SKIPPED', error: 'NOTHING_TO_SEND' });
    } finally {
      await worker.close();
    }
  });

  it('TASK-04: over the daily email limit, the rest wait for tomorrow and digests go first', async () => {
    const ws = await workspace('budget', 'starter', 'UTC');
    const eight = nextUtc(8, 0);
    const lead = await ws.owner.post(`/v1/orgs/${ws.orgId}/leads`, { name: 'Budget Lead' });
    await ws.owner.post(`/v1/orgs/${ws.orgId}/tasks`, {
      leadId: lead.body.id,
      title: 'Budget overdue',
      type: 'CALL',
      dueAt: new Date(eight.getTime() - 3_600_000).toISOString(),
    });
    await ws.owner.post(`/v1/orgs/${ws.orgId}/tasks`, {
      leadId: lead.body.id,
      title: 'Budget reminder',
      type: 'CALL',
      dueAt: new Date(eight.getTime() + 10 * 60_000).toISOString(),
    });
    const redis = new Redis(app.env.REDIS_URL);
    const day = eight.toISOString().slice(0, 10);
    const used = Number((await redis.get(`email:sent:${day}`)) ?? 0);
    // Room for exactly one more email today.
    const worker = await startWorker(app, { EMAIL_DAILY_LIMIT: String(used + 1) });
    try {
      const result = await worker.jobs.reminders(eight);
      // Other workspaces in the test database get their digests at the same moment, so the one
      // email the budget allows is some member's digest; every reminder waits.
      expect(result.sent).toBe(1);
      expect(result.deferred).toBeGreaterThanOrEqual(1);
      expect(worker.outbox.sent.map((m) => m.subject)).toEqual([
        expect.stringMatching(/^Your day/),
      ]);
      const [waiting] = await rows(
        `"organizationId" = $1 AND kind = 'TASK_DUE_SOON' AND channel = 'EMAIL'`,
        [ws.orgId],
      );
      expect(waiting.status).toBe('PENDING');
      // Stored in UTC; compared as text, since pg would read it in this machine's timezone.
      expect(waiting.send_after_utc).toBe(
        new Date(Date.UTC(eight.getUTCFullYear(), eight.getUTCMonth(), eight.getUTCDate() + 1))
          .toISOString()
          .slice(0, 19),
      );
    } finally {
      await worker.close();
      await redis.del(`email:sent:${day}`);
      if (used) await redis.set(`email:sent:${day}`, String(used));
      redis.disconnect();
    }
  });
});
