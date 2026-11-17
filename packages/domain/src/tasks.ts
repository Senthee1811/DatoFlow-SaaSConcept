import type { StageKind } from './pipeline.js';
import { endOfDayInZone } from './time.js';

// ---------------------------------------------------------------------------
// Tasks (TASK-01)
// ---------------------------------------------------------------------------

export const TASK_TYPES = ['CALL', 'EMAIL', 'WHATSAPP', 'MEETING', 'OTHER'] as const;
export type TaskType = (typeof TASK_TYPES)[number];

export const TASK_TYPE_LABEL: Record<TaskType, string> = {
  CALL: 'Call',
  EMAIL: 'Email',
  WHATSAPP: 'WhatsApp',
  MEETING: 'Meeting',
  OTHER: 'Other',
};

export const TASK_STATUSES = ['OPEN', 'DONE', 'CANCELLED'] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

/** A touch is human-initiated outbound contact: a call, an email, a message or a meeting. */
export const TOUCH_CHANNELS = ['CALL', 'EMAIL', 'WHATSAPP', 'MEETING'] as const;
export type TouchChannel = (typeof TOUCH_CHANNELS)[number];

export const TOUCH_LABEL: Record<TouchChannel, string> = {
  CALL: 'Call',
  EMAIL: 'Email',
  WHATSAPP: 'WhatsApp message',
  MEETING: 'Meeting',
};

export interface TaskLike {
  status: TaskStatus;
  dueAt: Date;
  assigneeId: string | null;
}

/** A next step is an open task linked to a lead, with a due date-time and an assignee. */
export function isNextStep(task: TaskLike): boolean {
  return task.status === 'OPEN' && task.assigneeId !== null;
}

/** An open task whose due time has passed. */
export function isOverdue(task: { status: TaskStatus; dueAt: Date }, now: Date): boolean {
  return task.status === 'OPEN' && task.dueAt.getTime() < now.getTime();
}

/**
 * The due time of a lead's earliest next step. Only open, unarchived leads have one: a closed
 * or archived lead needs no next step.
 */
export function nextStepDueAt(
  lead: { kind: StageKind; archivedAt: Date | null },
  tasks: TaskLike[],
): Date | null {
  if (lead.kind !== 'OPEN' || lead.archivedAt !== null) return null;
  let earliest: Date | null = null;
  for (const t of tasks) {
    if (isNextStep(t) && (earliest === null || t.dueAt < earliest)) earliest = t.dueAt;
  }
  return earliest;
}

// ---------------------------------------------------------------------------
// Next-step rule (TASK-02)
// ---------------------------------------------------------------------------

/** `require` refuses a touch without a next step; `warn` saves it and says so. */
export const NEXT_STEP_RULES = ['require', 'warn'] as const;
export type NextStepRule = (typeof NEXT_STEP_RULES)[number];

export type TouchDecision =
  | { ok: true; warning: null }
  | { ok: true; warning: 'NEXT_STEP_MISSING' }
  | { ok: false; code: 'NEXT_STEP_REQUIRED'; path: string; message: string };

/**
 * Logging a touch on an open lead requires a new open, dated task, unless the touch moves the
 * lead to Won or Lost. `kindAfter` is the lead's stage kind once the touch is saved.
 */
export function decideTouch(input: {
  kindAfter: StageKind;
  hasNewNextStep: boolean;
  rule: NextStepRule;
}): TouchDecision {
  if (input.kindAfter !== 'OPEN' || input.hasNewNextStep) return { ok: true, warning: null };
  if (input.rule === 'warn') return { ok: true, warning: 'NEXT_STEP_MISSING' };
  return {
    ok: false,
    code: 'NEXT_STEP_REQUIRED',
    path: 'body.nextStep',
    message: 'Set the next step, or mark the lead as Won or Lost',
  };
}

// ---------------------------------------------------------------------------
// Stuck-lead radar (TASK-03)
// ---------------------------------------------------------------------------

export type StuckReason = 'SLA' | 'NEXT_STEP_OVERDUE';

export interface RadarLead {
  kind: StageKind;
  archivedAt: Date | null;
  slaDueAt: Date | null;
  nextStepDueAt: Date | null;
}

/**
 * Why a lead is stuck: an open, unarchived lead with no activity for longer than its stage SLA,
 * or with an overdue next step. Empty when it is not stuck.
 */
export function stuckReasons(lead: RadarLead, now: Date): StuckReason[] {
  if (lead.kind !== 'OPEN' || lead.archivedAt !== null) return [];
  const reasons: StuckReason[] = [];
  if (lead.slaDueAt && lead.slaDueAt.getTime() < now.getTime()) reasons.push('SLA');
  if (lead.nextStepDueAt && lead.nextStepDueAt.getTime() < now.getTime())
    reasons.push('NEXT_STEP_OVERDUE');
  return reasons;
}

export function isStuck(lead: RadarLead, now: Date): boolean {
  return stuckReasons(lead, now).length > 0;
}

/** The first deadline the lead missed, or null when it is not stuck. Longest stuck sorts first. */
export function missedSince(lead: RadarLead, now: Date): Date | null {
  const missed = [lead.slaDueAt, lead.nextStepDueAt].filter(
    (d): d is Date => d !== null && d.getTime() < now.getTime(),
  );
  if (lead.kind !== 'OPEN' || lead.archivedAt !== null || missed.length === 0) return null;
  return new Date(Math.min(...missed.map((d) => d.getTime())));
}

// ---------------------------------------------------------------------------
// My day (TASK-05)
// ---------------------------------------------------------------------------

/** The calendar date (YYYY-MM-DD) of `instant` in `timeZone`. */
export function localDate(instant: Date, timeZone: string): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(instant);
}

/** The hour (0 to 23) of `instant` in `timeZone`. */
export function localHour(instant: Date, timeZone: string): number {
  return Number(
    new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', hourCycle: 'h23' }).format(
      instant,
    ),
  );
}

/** The exclusive end of today in the organization's timezone. */
export function endOfToday(now: Date, timeZone: string): Date {
  return endOfDayInZone(localDate(now, timeZone), timeZone);
}

const PRIORITY_RANK = { HIGH: 0, NORMAL: 1, LOW: 2 } as const;

/**
 * My day: overdue next steps first, then the ones due later today, each earliest first and
 * high priority first on a tie. Next steps due after today are left out.
 */
export function planDay<T extends { dueAt: Date; priority: keyof typeof PRIORITY_RANK }>(
  tasks: T[],
  now: Date,
  timeZone: string,
): { overdue: T[]; today: T[] } {
  const end = endOfToday(now, timeZone).getTime();
  const order = (a: T, b: T) =>
    a.dueAt.getTime() - b.dueAt.getTime() || PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority];
  const overdue = tasks.filter((t) => t.dueAt.getTime() < now.getTime()).sort(order);
  const today = tasks
    .filter((t) => t.dueAt.getTime() >= now.getTime() && t.dueAt.getTime() < end)
    .sort(order);
  return { overdue, today };
}

/** Stuck leads for My day, longest stuck first. */
export function orderStuck<T extends RadarLead>(leads: T[], now: Date): T[] {
  return leads
    .map((lead) => ({ lead, since: missedSince(lead, now) }))
    .filter((x): x is { lead: T; since: Date } => x.since !== null)
    .sort((a, b) => a.since.getTime() - b.since.getTime())
    .map((x) => x.lead);
}

// ---------------------------------------------------------------------------
// Reminders and the daily digest (TASK-04)
// ---------------------------------------------------------------------------

/** Reminders go out this many minutes before a next step is due. */
export const REMINDER_MINUTES_BEFORE = 15;
/** The daily digest goes out at this hour in the organization's timezone. */
export const DIGEST_HOUR = 8;

export type ReminderChannel = 'IN_APP' | 'EMAIL';

/**
 * Each reminder is sent once. The key is the task, the channel and the due time, so moving a
 * next step to a new time earns a new reminder and nothing else does.
 */
export function reminderKey(taskId: string, channel: ReminderChannel, dueAt: Date): string {
  return `reminder:${taskId}:${channel}:${dueAt.toISOString()}`;
}

/** Whether a next step due at `dueAt` should be reminded now: not yet due, due within 15 minutes. */
export function reminderDue(dueAt: Date, now: Date): boolean {
  const left = dueAt.getTime() - now.getTime();
  return left > 0 && left <= REMINDER_MINUTES_BEFORE * 60_000;
}

/** The latest due time a reminder scan at `now` covers. */
export function reminderHorizon(now: Date): Date {
  return new Date(now.getTime() + REMINDER_MINUTES_BEFORE * 60_000);
}

export function digestKey(organizationId: string, userId: string, date: string): string {
  return `digest:${organizationId}:${userId}:${date}`;
}

/** Whether today's digest is due: from 08:00 in the organization's timezone until midnight. */
export function digestDue(now: Date, timeZone: string): { due: boolean; date: string } {
  return { due: localHour(now, timeZone) >= DIGEST_HOUR, date: localDate(now, timeZone) };
}

// ---------------------------------------------------------------------------
// Daily email budget (free-tier limit, section 3)
// ---------------------------------------------------------------------------

export type EmailKind = 'DIGEST' | 'REMINDER';

/** Within one send run, daily digests go first, then reminders, oldest first. */
export function emailOrder(kind: EmailKind): number {
  return kind === 'DIGEST' ? 0 : 1;
}

/**
 * Whether one more email fits under the provider's daily limit. Overflow waits for the next day
 * (UTC, when the provider's counter resets).
 */
export function emailBudget(
  sentToday: number,
  dailyLimit: number,
  now: Date,
): { send: true } | { send: false; retryAt: Date } {
  if (sentToday < dailyLimit) return { send: true };
  const next = new Date(now);
  next.setUTCHours(24, 0, 0, 0);
  return { send: false, retryAt: next };
}

/** The UTC day the provider counts sends against, as YYYY-MM-DD. */
export function emailBudgetDay(now: Date): string {
  return now.toISOString().slice(0, 10);
}
