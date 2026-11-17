import {
  countEmailSent,
  emailsSentToday,
  type Counter,
  type EmailAdapter,
  type EmailMessage,
} from '@datoflow/adapters';
import type { Db } from '@datoflow/db';
import { emailBudget, TASK_TYPE_LABEL, type TaskType } from '@datoflow/domain';
import type { Logger } from 'pino';
import { KIND } from './scan.js';

/** A claim older than this belongs to a worker that stopped mid-send. */
export const SEND_LEASE_MS = 2 * 60_000;
const MAX_ATTEMPTS = 5;
const BATCH = 50;

export interface DeliverOptions {
  appUrl: string;
  dailyLimit: number;
  logger?: Logger;
}

type Row = {
  id: string;
  kind: string;
  dedupeKey: string | null;
  payload: unknown;
  userId: string | null;
  toAddress?: string | null;
};

function when(iso: string, timezone: string, withDate: boolean) {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: timezone,
    hour: '2-digit',
    minute: '2-digit',
    ...(withDate ? { day: 'numeric', month: 'short' } : {}),
  }).format(new Date(iso));
}

interface Step {
  leadId: string;
  leadName: string;
  title: string;
  type: TaskType;
  dueAt: string;
}

/** The email for one delivery row. Links point at the lead or My day in the web app. */
export function compose(row: Row, to: string, appUrl: string): EmailMessage {
  const p = row.payload as Record<string, unknown>;
  const tz = String(p.timezone ?? 'UTC');
  const base = `${appUrl}/app/${String(p.orgSlug)}`;
  const footer = `\n\nChange reminder emails on your Account page: ${base}/account`;
  const key = row.dedupeKey ? { idempotencyKey: row.dedupeKey } : {};
  if (row.kind === KIND.WORKFLOW_EMAIL) {
    // Subject and body were filled in when the workflow action ran.
    return { to, subject: String(p.subject), text: String(p.body), ...key };
  }
  if (row.kind === KIND.DUE_SOON) {
    const company = p.leadCompany ? `, ${String(p.leadCompany)}` : '';
    return {
      to,
      subject: `Due at ${when(String(p.dueAt), tz, false)}: ${String(p.title)}`,
      text:
        `Your next step is due in 15 minutes.\n\n` +
        `${String(p.title)} (${TASK_TYPE_LABEL[p.type as TaskType] ?? 'Task'})\n` +
        `Lead: ${String(p.leadName)}${company}\n` +
        `Due: ${when(String(p.dueAt), tz, true)}\n\n` +
        `Open the lead: ${base}/leads/${String(p.leadId)}` +
        footer,
      ...key,
    };
  }
  const overdue = (p.overdue as Step[]) ?? [];
  const today = (p.today as Step[]) ?? [];
  const stuck = (p.stuck as { leadId: string; name: string; company: string | null }[]) ?? [];
  const line = (s: Step, withDate: boolean) =>
    `- ${when(s.dueAt, tz, withDate)}  ${s.title}, ${s.leadName}\n  ${base}/leads/${s.leadId}`;
  const parts = [
    overdue.length ? `Overdue next steps\n${overdue.map((s) => line(s, true)).join('\n')}` : null,
    today.length ? `Due today\n${today.map((s) => line(s, false)).join('\n')}` : null,
    stuck.length
      ? `Your stuck leads\n${stuck
          .map(
            (l) => `- ${l.name}${l.company ? `, ${l.company}` : ''}\n  ${base}/leads/${l.leadId}`,
          )
          .join('\n')}`
      : null,
  ].filter(Boolean);
  const counts = [
    overdue.length ? `${overdue.length} overdue` : null,
    today.length ? `${today.length} due today` : null,
    stuck.length ? `${stuck.length} stuck ${stuck.length === 1 ? 'lead' : 'leads'}` : null,
  ].filter(Boolean);
  return {
    to,
    subject: `Your day in ${String(p.orgName)}: ${counts.join(', ')}`,
    text: `${parts.join('\n\n')}\n\nOpen My day: ${base}/day${footer}`,
    ...key,
  };
}

/**
 * A worker that stopped between claiming an email and recording the result left it SENDING. With a
 * provider that drops repeats of the same key (Resend), sending again is safe. With any other the
 * email may already have gone, so it is skipped rather than risk a second copy.
 */
export async function recoverInterrupted(db: Db, email: EmailAdapter, now: Date) {
  return db.withSystem(async (tx) => {
    const where = {
      channel: 'EMAIL' as const,
      status: 'SENDING' as const,
      claimedAt: { lt: new Date(now.getTime() - SEND_LEASE_MS) },
    };
    const { count } = email.idempotent
      ? await tx.notification.updateMany({ where, data: { status: 'PENDING', claimedAt: null } })
      : await tx.notification.updateMany({
          where,
          data: { status: 'SKIPPED', error: 'INTERRUPTED' },
        });
    return count;
  });
}

/**
 * Sends waiting reminder and digest emails, digests first. Each email is claimed (PENDING to
 * SENDING) and committed before it is sent, and marked SENT after, so two workers never send the
 * same row and a restart never repeats a finished one. Over the daily budget, the rest wait for
 * the next day.
 */
export async function deliverEmails(
  db: Db,
  email: EmailAdapter,
  counter: Counter,
  options: DeliverOptions,
  now = new Date(),
): Promise<{ sent: number; skipped: number; deferred: number; failed: number }> {
  const result = { sent: 0, skipped: 0, deferred: 0, failed: 0 };
  await recoverInterrupted(db, email, now);

  const waiting = (kind: string) =>
    db.withSystem((tx) =>
      tx.notification.findMany({
        where: { channel: 'EMAIL', status: 'PENDING', kind, sendAfter: { lte: now } },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        take: BATCH,
        select: {
          id: true,
          kind: true,
          dedupeKey: true,
          payload: true,
          userId: true,
          toAddress: true,
          organizationId: true,
          staleAt: true,
        },
      }),
    );
  // Daily digests go first, then reminders, then emails scheduled by workflows.
  const rows = [
    ...(await waiting(KIND.DIGEST)),
    ...(await waiting(KIND.DUE_SOON)),
    ...(await waiting(KIND.WORKFLOW_EMAIL)),
  ];

  for (const row of rows) {
    if (row.staleAt && row.staleAt.getTime() <= now.getTime()) {
      await db.withSystem((tx) =>
        tx.notification.updateMany({
          where: { id: row.id, status: 'PENDING' },
          data: { status: 'SKIPPED', error: 'TOO_LATE' },
        }),
      );
      result.skipped += 1;
      continue;
    }
    const budget = emailBudget(await emailsSentToday(counter, now), options.dailyLimit, now);
    if (!budget.send) {
      // The provider's limit is spent: everything still waiting goes out tomorrow.
      const { count } = await db.withSystem((tx) =>
        tx.notification.updateMany({
          where: { channel: 'EMAIL', status: 'PENDING', sendAfter: { lte: now } },
          data: { sendAfter: budget.retryAt },
        }),
      );
      result.deferred += count;
      options.logger?.warn({ deferred: count }, 'daily email budget spent');
      break;
    }

    const claim = await db.withSystem(async (tx) => {
      const { count } = await tx.notification.updateMany({
        where: { id: row.id, status: 'PENDING' },
        data: { status: 'SENDING', claimedAt: now, attempts: { increment: 1 } },
      });
      if (count !== 1) return null;
      const fresh = await tx.notification.findUniqueOrThrow({
        where: { id: row.id },
        select: { attempts: true },
      });
      // An address outside the workspace (a lead's) is used as given.
      if (row.toAddress) return { to: row.toAddress, attempts: fresh.attempts };
      const member = row.userId
        ? await tx.organizationMembership.findFirst({
            where: { organizationId: row.organizationId, userId: row.userId, isSample: false },
            select: { user: { select: { email: true } } },
          })
        : null;
      return { to: member?.user.email ?? null, attempts: fresh.attempts };
    });
    if (!claim) continue; // Another worker has it.
    if (!claim.to) {
      await db.withSystem((tx) =>
        tx.notification.update({
          where: { id: row.id },
          data: { status: 'SKIPPED', error: 'NOT_A_MEMBER' },
        }),
      );
      result.skipped += 1;
      continue;
    }

    try {
      await email.send(compose(row, claim.to, options.appUrl));
    } catch (err) {
      const message = (err as Error).message.slice(0, 500);
      const last = claim.attempts >= MAX_ATTEMPTS;
      await db.withSystem((tx) =>
        tx.notification.update({
          where: { id: row.id },
          data: last
            ? { status: 'FAILED', error: message }
            : {
                status: 'PENDING',
                claimedAt: null,
                error: message,
                sendAfter: new Date(now.getTime() + 2 ** claim.attempts * 60_000),
              },
        }),
      );
      options.logger?.error({ notificationId: row.id, err: message }, 'email delivery failed');
      result.failed += 1;
      continue;
    }
    await countEmailSent(counter, now).catch(() => undefined);
    await db.withSystem((tx) =>
      tx.notification.update({
        where: { id: row.id },
        data: { status: 'SENT', sentAt: new Date(), error: null },
      }),
    );
    result.sent += 1;
  }
  return result;
}
