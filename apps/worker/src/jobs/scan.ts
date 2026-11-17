import type { Db, Tx } from '@datoflow/db';
import {
  digestDue,
  digestKey,
  endOfToday,
  hasFeature,
  orderStuck,
  planDay,
  reminderHorizon,
  reminderKey,
  stuckReasons,
} from '@datoflow/domain';

/** Notification kinds the worker writes. */
export const KIND = {
  DUE_SOON: 'TASK_DUE_SOON',
  DIGEST: 'DAILY_DIGEST',
} as const;

interface MemberPrefs {
  isSample: boolean;
  reminderEmail: boolean;
  dailyDigest: boolean;
}

function prefsOf(m: { isSample: boolean; preferences: unknown }): MemberPrefs {
  const n = ((m.preferences ?? {}) as { notifications?: Record<string, unknown> }).notifications;
  return {
    isSample: m.isSample,
    reminderEmail: n?.reminderEmail !== false,
    dailyDigest: n?.dailyDigest !== false,
  };
}

async function membersByKey(tx: Tx, pairs: { organizationId: string; userId: string }[]) {
  const rows = pairs.length
    ? await tx.organizationMembership.findMany({
        where: { OR: pairs.map((p) => ({ organizationId: p.organizationId, userId: p.userId })) },
        select: { organizationId: true, userId: true, isSample: true, preferences: true },
      })
    : [];
  return new Map(rows.map((m) => [`${m.organizationId}:${m.userId}`, prefsOf(m)]));
}

/**
 * Reminders (TASK-04): for every next step due within 15 minutes, an in-app reminder, and an email
 * when the assignee wants one and the plan includes email reminders. Each is a row keyed by task,
 * channel and due time, inserted with ON CONFLICT DO NOTHING, so however often the scan runs (or
 * however many workers run it) each reminder exists once.
 */
export async function scanReminders(db: Db, now: Date): Promise<{ created: number }> {
  return db.withSystem(async (tx) => {
    const tasks = await tx.task.findMany({
      where: {
        status: 'OPEN',
        assigneeId: { not: null },
        dueAt: { gt: now, lte: reminderHorizon(now) },
        lead: { archivedAt: null, stage: { kind: 'OPEN' } },
        organization: { deletedAt: null },
      },
      include: {
        lead: { select: { name: true, company: true } },
        organization: { select: { slug: true, name: true, timezone: true, planCode: true } },
      },
    });
    const members = await membersByKey(
      tx,
      tasks.map((t) => ({ organizationId: t.organizationId, userId: t.assigneeId! })),
    );
    const rows = tasks.flatMap((t) => {
      const member = members.get(`${t.organizationId}:${t.assigneeId}`);
      // Sample reps cannot sign in, and someone who left the workspace is not reminded.
      if (!member || member.isSample) return [];
      const payload = {
        taskId: t.id,
        leadId: t.leadId,
        leadName: t.lead.name,
        leadCompany: t.lead.company,
        title: t.title,
        type: t.type,
        dueAt: t.dueAt.toISOString(),
        orgSlug: t.organization.slug,
        orgName: t.organization.name,
        timezone: t.organization.timezone,
      };
      const base = { organizationId: t.organizationId, userId: t.assigneeId!, kind: KIND.DUE_SOON };
      const inApp = {
        ...base,
        channel: 'IN_APP' as const,
        payload,
        dedupeKey: reminderKey(t.id, 'IN_APP', t.dueAt),
        status: 'SENT' as const,
        sentAt: now,
        createdAt: now,
      };
      const wantsEmail =
        member.reminderEmail && hasFeature(t.organization.planCode, 'emailReminders');
      const email = {
        ...base,
        channel: 'EMAIL' as const,
        payload,
        dedupeKey: reminderKey(t.id, 'EMAIL', t.dueAt),
        status: 'PENDING' as const,
        sendAfter: now,
        // A reminder that cannot go out before the step is due is no longer worth sending.
        staleAt: t.dueAt,
        createdAt: now,
      };
      return wantsEmail ? [inApp, email] : [inApp];
    });
    if (rows.length === 0) return { created: 0 };
    const { count } = await tx.notification.createMany({ data: rows, skipDuplicates: true });
    return { created: count };
  });
}

/**
 * The daily digest (TASK-04): from 08:00 in each organization's timezone, one email per member
 * with their overdue next steps, today's next steps and their stuck leads. The content is fixed
 * when the row is written, so a later send (after a restart or a full budget) sends the same email.
 */
export async function scanDigests(db: Db, now: Date): Promise<{ created: number }> {
  return db.withSystem(async (tx) => {
    const orgs = await tx.organization.findMany({
      where: { deletedAt: null },
      select: { id: true, slug: true, name: true, timezone: true, planCode: true },
    });
    let created = 0;
    for (const org of orgs) {
      if (!hasFeature(org.planCode, 'emailReminders')) continue;
      const { due, date } = digestDue(now, org.timezone);
      if (!due) continue;
      const memberships = await tx.organizationMembership.findMany({
        where: { organizationId: org.id, isSample: false },
        select: { userId: true, isSample: true, preferences: true },
      });
      const wanted = memberships.filter((m) => prefsOf(m).dailyDigest);
      const keys = wanted.map((m) => digestKey(org.id, m.userId, date));
      const done = new Set(
        (
          await tx.notification.findMany({
            where: { dedupeKey: { in: keys } },
            select: { dedupeKey: true },
          })
        ).map((n) => n.dedupeKey),
      );
      for (const m of wanted) {
        const key = digestKey(org.id, m.userId, date);
        if (done.has(key)) continue;
        const content = await digestContent(tx, org, m.userId, now);
        const empty = !content.overdue.length && !content.today.length && !content.stuck.length;
        const { count } = await tx.notification.createMany({
          data: [
            {
              organizationId: org.id,
              userId: m.userId,
              kind: KIND.DIGEST,
              channel: 'EMAIL',
              dedupeKey: key,
              // Nothing to report: recorded, so the scan does not look again today, but not sent.
              status: empty ? 'SKIPPED' : 'PENDING',
              error: empty ? 'NOTHING_TO_SEND' : null,
              sendAfter: now,
              staleAt: new Date(now.getTime() + 24 * 3_600_000),
              payload: {
                date,
                orgSlug: org.slug,
                orgName: org.name,
                timezone: org.timezone,
                ...content,
              },
              createdAt: now,
            },
          ],
          skipDuplicates: true,
        });
        created += empty ? 0 : count;
      }
    }
    return { created };
  });
}

async function digestContent(
  tx: Tx,
  org: { id: string; timezone: string },
  userId: string,
  now: Date,
) {
  const tasks = await tx.task.findMany({
    where: {
      organizationId: org.id,
      assigneeId: userId,
      status: 'OPEN',
      dueAt: { lt: endOfToday(now, org.timezone) },
      lead: { archivedAt: null, stage: { kind: 'OPEN' } },
    },
    include: { lead: { select: { name: true, company: true } } },
    take: 100,
  });
  const { overdue, today } = planDay(tasks, now, org.timezone);
  const leads = await tx.lead.findMany({
    where: {
      organizationId: org.id,
      ownerId: userId,
      archivedAt: null,
      stage: { kind: 'OPEN' },
      OR: [{ slaDueAt: { lt: now } }, { nextStepDueAt: { lt: now } }],
    },
    include: { stage: { select: { kind: true } } },
    take: 100,
  });
  const stuck = orderStuck(
    leads.map((l) => ({ ...l, kind: l.stage.kind })),
    now,
  );
  const step = (t: (typeof tasks)[number]) => ({
    taskId: t.id,
    leadId: t.leadId,
    leadName: t.lead.name,
    title: t.title,
    type: t.type,
    dueAt: t.dueAt.toISOString(),
  });
  return {
    overdue: overdue.map(step),
    today: today.map(step),
    stuck: stuck.map((l) => ({
      leadId: l.id,
      name: l.name,
      company: l.company,
      reasons: stuckReasons(l, now),
    })),
  };
}
