import { Prisma, type Db, type Tx } from '@datoflow/db';
import { planFor } from '@datoflow/domain';
import {
  admit,
  CLAIMABLE,
  decideFailure,
  evaluateConditions,
  isRetryable,
  monthStart,
  TRIGGERS,
  ActionError,
  type Action,
  type Backoff,
  type Condition,
  type ExecutionStatus,
  type SkipReason,
  type Trigger,
} from '@datoflow/workflow';
import type { Logger } from 'pino';
import { performAction, WORKFLOW_KIND, type RunContext } from './actions.js';

/** A test hook called before each action runs. Throwing from it fails the step. */
export type FaultHook = (step: {
  executionId: string;
  workflowName: string;
  stepIndex: number;
  action: Action;
  attempt: number;
}) => void | Promise<void>;

export interface EngineDeps {
  db: Db;
  logger?: Logger;
  backoff: Backoff;
  leaseMs: number;
  random?: () => number;
  faults?: FaultHook;
}

// ---------------------------------------------------------------------------
// Outbox publisher
// ---------------------------------------------------------------------------

/**
 * Moves unpublished outbox events to the queue, oldest first, and marks them published in the
 * same transaction. Rows are locked with SKIP LOCKED, so two publishers never take the same event.
 * If the commit fails after the jobs were added, the events are published again; the job id and
 * the unique (version, event) execution make that harmless (WF-07).
 */
export async function publishOutbox(
  db: Db,
  enqueue: (eventIds: string[]) => Promise<void>,
  batch = 200,
): Promise<number> {
  return db.withSystem(async (tx) => {
    const rows = await tx.$queryRaw<{ id: string }[]>`
      SELECT id FROM "OutboxEvent"
      WHERE "publishedAt" IS NULL
      ORDER BY "createdAt", id
      LIMIT ${batch}
      FOR UPDATE SKIP LOCKED`;
    if (rows.length === 0) return 0;
    const ids = rows.map((r) => r.id);
    await enqueue(ids);
    await tx.outboxEvent.updateMany({
      where: { id: { in: ids } },
      data: { publishedAt: new Date() },
    });
    return ids.length;
  });
}

// ---------------------------------------------------------------------------
// Dispatcher
// ---------------------------------------------------------------------------

interface Subject {
  leadId: string | null;
  lead: { source: string; stageId: string; ownerId: string | null; priority: string } | null;
  /** For task.deadline_reached: the task's assignee is the condition's assignee. */
  assignee: string | null;
}

async function subjectOf(
  tx: Tx,
  event: { type: string; aggregateType: string; aggregateId: string; payload: unknown },
): Promise<Subject> {
  const payload = (event.payload ?? {}) as Record<string, unknown>;
  const leadId =
    event.aggregateType === 'Lead'
      ? event.aggregateId
      : typeof payload.leadId === 'string'
        ? payload.leadId
        : null;
  const lead = leadId
    ? await tx.lead.findUnique({
        where: { id: leadId },
        select: { source: true, stageId: true, ownerId: true, priority: true },
      })
    : null;
  const assignee =
    event.type === 'task.deadline_reached'
      ? typeof payload.assigneeId === 'string'
        ? payload.assigneeId
        : null
      : (lead?.ownerId ?? null);
  return { leadId, lead, assignee };
}

/**
 * Turns one event into runs (UF-3). Every active workflow whose active version has this trigger
 * gets one execution row; the unique (version, event) pair means a replayed event is dropped
 * (WF-07). Loop protection (WF-09) and conditions (WF-03) decide SKIPPED; the rest are QUEUED.
 * Returns the queued run ids.
 */
export async function dispatchEvent(
  deps: EngineDeps,
  eventId: string,
  now = new Date(),
): Promise<string[]> {
  const event = await deps.db.withSystem((tx) =>
    tx.outboxEvent.findUnique({ where: { id: eventId } }),
  );
  if (!event || !(TRIGGERS as readonly string[]).includes(event.type)) return [];
  const payload = (event.payload ?? {}) as Record<string, unknown>;
  const isSample = payload.isSample === true;

  return deps.db.withTenant(event.organizationId, async (tx) => {
    // Sample workflows run on sample leads only, and real ones on real leads only.
    const workflows = await tx.workflow.findMany({
      where: { status: 'ACTIVE', isSample, activeVersionId: { not: null } },
      select: { id: true, activeVersionId: true },
    });
    if (workflows.length === 0) return [];
    const versions = await tx.workflowVersion.findMany({
      where: {
        id: { in: workflows.map((w) => w.activeVersionId!) },
        trigger: event.type as Trigger,
      },
      select: { id: true, workflowId: true, conditions: true },
    });
    if (versions.length === 0) return [];

    const subject = await subjectOf(tx, event);
    const cause = event.causationId
      ? await tx.workflowExecution.findUnique({
          where: { id: event.causationId },
          select: { workflowId: true },
        })
      : null;
    const org = await tx.organization.findUniqueOrThrow({
      where: { id: event.organizationId },
      select: { planCode: true },
    });
    // Sample runs never count against the plan (sample data never counts).
    const monthlyCap = isSample ? null : planFor(org.planCode).limits.executionsPerMonth;
    let runsThisMonth = isSample
      ? 0
      : await tx.workflowExecution.count({
          where: {
            isSample: false,
            createdAt: { gte: monthStart(now) },
            status: { notIn: ['SKIPPED'] },
          },
        });

    const rows = versions.map((v) => {
      let skip: SkipReason | null = null;
      const admission = admit({
        depth: event.depth,
        selfTriggered: cause?.workflowId === v.workflowId,
        runsThisMonth,
        monthlyCap,
      });
      if (!admission.ok) skip = admission.reason;
      else if (!subject.lead) skip = 'LEAD_NOT_FOUND';
      else {
        const result = evaluateConditions(v.conditions as unknown as Condition[], {
          source: subject.lead.source,
          stage: subject.lead.stageId,
          assignee: subject.assignee,
          priority: subject.lead.priority,
        });
        if (!result.ok) skip = 'CONDITIONS_NOT_MET';
      }
      if (!skip) runsThisMonth += 1;
      return {
        organizationId: event.organizationId,
        workflowId: v.workflowId,
        versionId: v.id,
        eventId: event.id,
        eventType: event.type,
        leadId: subject.leadId,
        depth: event.depth,
        isSample,
        status: (skip ? 'SKIPPED' : 'QUEUED') as ExecutionStatus,
        skipReason: skip,
        finishedAt: skip ? now : null,
        createdAt: now,
      };
    });
    // ON CONFLICT DO NOTHING: a replayed event creates no second execution (WF-07).
    const created = await tx.workflowExecution.createManyAndReturn({
      data: rows,
      skipDuplicates: true,
      select: { id: true, status: true },
    });
    if (created.length < rows.length) {
      deps.logger?.info(
        { eventId, dropped: rows.length - created.length },
        'replayed event: runs already exist',
      );
    }
    return created.filter((c) => c.status === 'QUEUED').map((c) => c.id);
  });
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

export type RunOutcome =
  | { status: 'SUCCEEDED' | 'CANCELLED' | 'DEAD' }
  | { status: 'FAILED'; retryAt: Date; round: number; attempt: number }
  | { status: 'NOT_CLAIMED' };

/** The lease is ours while the run is RUNNING with our attempt. Each step renews it. */
async function holdLease(tx: Tx, executionId: string, attempt: number, now: Date) {
  const { count } = await tx.workflowExecution.updateMany({
    where: { id: executionId, status: 'RUNNING', attempt },
    data: { claimedAt: now },
  });
  if (count !== 1) throw new LeaseLost();
}

class LeaseLost extends Error {
  constructor() {
    super('Another worker took over this run');
  }
}

/** Notifies the organization's Owners and Admins in-app that a run is DEAD (WF-08). */
async function notifyDead(
  tx: Tx,
  e: {
    id: string;
    organizationId: string;
    workflowId: string;
    leadId: string | null;
    manualRetries: number;
  },
  workflowName: string,
  error: string,
  now: Date,
) {
  const admins = await tx.organizationMembership.findMany({
    where: { role: { in: ['OWNER', 'ADMIN'] }, isSample: false },
    select: { userId: true },
  });
  const lead = e.leadId
    ? await tx.lead.findUnique({ where: { id: e.leadId }, select: { name: true } })
    : null;
  await tx.notification.createMany({
    data: admins.map((a) => ({
      organizationId: e.organizationId,
      userId: a.userId,
      kind: WORKFLOW_KIND.DEAD,
      channel: 'IN_APP' as const,
      status: 'SENT' as const,
      sentAt: now,
      dedupeKey: `wf-dead:${e.id}:${e.manualRetries}:${a.userId}`,
      payload: {
        executionId: e.id,
        workflowId: e.workflowId,
        workflowName,
        leadId: e.leadId,
        leadName: lead?.name ?? null,
        error,
      },
      createdAt: now,
    })),
    skipDuplicates: true,
  });
}

/**
 * Runs one execution (UF-3): claims it, runs each action that has not succeeded yet, each in its
 * own transaction with its step row (WF-07), and records the outcome. A retryable failure is
 * retried with backoff up to 5 attempts; a validation or permission error, or the 5th failure,
 * makes the run DEAD and notifies Admins (WF-08).
 */
export async function runExecution(
  deps: EngineDeps,
  executionId: string,
  now = new Date(),
): Promise<RunOutcome> {
  const { db } = deps;
  const claim = await db.withSystem(async (tx) => {
    const e = await tx.workflowExecution.findUnique({
      where: { id: executionId },
      include: {
        workflow: { select: { name: true, status: true } },
        version: { select: { actions: true } },
      },
    });
    if (!e || !CLAIMABLE.includes(e.status)) return null;
    if (e.status === 'FAILED' && e.nextAttemptAt && e.nextAttemptAt > now) return null;
    // A paused workflow's waiting runs are cancelled, never started (WF-05).
    if (e.workflow.status !== 'ACTIVE') {
      await tx.workflowExecution.updateMany({
        where: { id: e.id, status: e.status },
        data: {
          status: 'CANCELLED',
          finishedAt: now,
          nextAttemptAt: null,
          error: 'The workflow was paused',
        },
      });
      return { cancelled: true as const };
    }
    const attempt = e.attempt + 1;
    const { count } = await tx.workflowExecution.updateMany({
      where: { id: e.id, status: e.status, attempt: e.attempt },
      data: {
        status: 'RUNNING',
        attempt,
        claimedAt: now,
        startedAt: e.startedAt ?? now,
        nextAttemptAt: null,
      },
    });
    if (count !== 1) return null; // Another worker claimed it first.
    const org = await tx.organization.findUniqueOrThrow({
      where: { id: e.organizationId },
      select: { name: true },
    });
    return { cancelled: false as const, e, attempt, orgName: org.name };
  });
  if (!claim) return { status: 'NOT_CLAIMED' };
  if (claim.cancelled) return { status: 'CANCELLED' };
  const { e, attempt, orgName } = claim;
  const actions = e.version.actions as unknown as Action[];

  const done = new Set(
    (
      await db.withTenant(e.organizationId, (tx) =>
        tx.workflowExecutionStep.findMany({
          where: { executionId: e.id, status: 'SUCCEEDED' },
          select: { stepIndex: true },
        }),
      )
    ).map((s) => s.stepIndex),
  );

  for (const [stepIndex, action] of actions.entries()) {
    if (done.has(stepIndex)) continue; // Succeeded in an earlier attempt: never repeated.
    const stepNow = new Date(Math.max(now.getTime(), Date.now()));
    try {
      await db.withTenant(e.organizationId, async (tx) => {
        await holdLease(tx, e.id, attempt, stepNow);
        await deps.faults?.({
          executionId: e.id,
          workflowName: e.workflow.name,
          stepIndex,
          action,
          attempt,
        });
        if (!e.leadId) throw new ActionError('NOT_FOUND', 'The event has no lead');
        const ctx: RunContext = {
          executionId: e.id,
          workflowId: e.workflowId,
          workflowName: e.workflow.name,
          organizationId: e.organizationId,
          orgName,
          leadId: e.leadId,
          depth: e.depth,
          attempt,
          now: stepNow,
        };
        const result = await performAction(tx, ctx, action, stepIndex);
        await tx.workflowExecutionStep.upsert({
          where: { executionId_stepIndex: { executionId: e.id, stepIndex } },
          create: {
            organizationId: e.organizationId,
            executionId: e.id,
            stepIndex,
            actionType: action.type,
            status: 'SUCCEEDED',
            attempt,
            result: result as Prisma.InputJsonValue,
            finishedAt: stepNow,
          },
          update: {
            status: 'SUCCEEDED',
            attempt,
            result: result as Prisma.InputJsonValue,
            error: null,
            finishedAt: stepNow,
          },
        });
      });
    } catch (err) {
      if (err instanceof LeaseLost) return { status: 'NOT_CLAIMED' };
      return fail(deps, e, attempt, stepIndex, action, err, stepNow);
    }
  }

  const { count } = await db.withTenant(e.organizationId, (tx) =>
    tx.workflowExecution.updateMany({
      where: { id: e.id, status: 'RUNNING', attempt },
      data: {
        status: 'SUCCEEDED',
        finishedAt: new Date(),
        claimedAt: null,
        error: null,
        errorKind: null,
      },
    }),
  );
  return count === 1 ? { status: 'SUCCEEDED' } : { status: 'NOT_CLAIMED' };
}

async function fail(
  deps: EngineDeps,
  e: {
    id: string;
    organizationId: string;
    workflowId: string;
    leadId: string | null;
    manualRetries: number;
    workflow: { name: string };
  },
  attempt: number,
  stepIndex: number,
  action: Action,
  err: unknown,
  now: Date,
): Promise<RunOutcome> {
  const message = (err instanceof Error ? err.message : String(err)).slice(0, 1000);
  const kind = err instanceof ActionError ? err.kind : 'TRANSIENT';
  const decision = decideFailure(attempt, err, now, deps.backoff, deps.random);
  deps.logger?.warn(
    { executionId: e.id, stepIndex, attempt, kind, retryable: isRetryable(err), err: message },
    'workflow step failed',
  );
  const recorded = await deps.db.withTenant(e.organizationId, async (tx) => {
    await tx.workflowExecutionStep.upsert({
      where: { executionId_stepIndex: { executionId: e.id, stepIndex } },
      create: {
        organizationId: e.organizationId,
        executionId: e.id,
        stepIndex,
        actionType: action.type,
        status: 'FAILED',
        attempt,
        error: message,
        finishedAt: now,
      },
      update: { status: 'FAILED', attempt, error: message, finishedAt: now },
    });
    const { count } = await tx.workflowExecution.updateMany({
      where: { id: e.id, status: 'RUNNING', attempt },
      data: {
        status: decision.status,
        error: `Step ${stepIndex + 1} (${action.type}): ${message}`,
        errorKind: kind,
        claimedAt: null,
        ...(decision.status === 'FAILED'
          ? { nextAttemptAt: decision.retryAt }
          : { nextAttemptAt: null, finishedAt: now }),
      },
    });
    if (count === 1 && decision.status === 'DEAD') {
      await notifyDead(tx, e, e.workflow.name, message, now);
    }
    return count === 1;
  });
  if (!recorded) return { status: 'NOT_CLAIMED' };
  return decision.status === 'FAILED'
    ? { status: 'FAILED', retryAt: decision.retryAt, round: e.manualRetries, attempt }
    : { status: 'DEAD' };
}

// ---------------------------------------------------------------------------
// Sweep
// ---------------------------------------------------------------------------

export interface SweepResult {
  /** Runs to put back on the queue: id, retry round and attempts so far. */
  requeue: { executionId: string; round: number; attempt: number }[];
  /** Attempts cut short by a worker that stopped. */
  interrupted: number;
}

/**
 * Recovers runs (NFR-REL-01): an attempt whose worker stopped (no lease renewal for `leaseMs`)
 * counts as a failed attempt and is retried, or is DEAD after the 5th; queued runs and due
 * retries whose job was lost go back on the queue. Claims make re-queuing safe: a run that is
 * already going is never started twice.
 */
export async function sweepExecutions(deps: EngineDeps, now = new Date()): Promise<SweepResult> {
  const stale = new Date(now.getTime() - deps.leaseMs);
  const interrupted = await deps.db.withSystem((tx) =>
    tx.workflowExecution.findMany({
      where: { status: 'RUNNING', claimedAt: { lt: stale } },
      include: { workflow: { select: { name: true } } },
      take: 200,
    }),
  );
  for (const e of interrupted) {
    const err = new Error('The worker stopped during this attempt');
    const decision = decideFailure(e.attempt, err, now, deps.backoff, deps.random);
    await deps.db.withTenant(e.organizationId, async (tx) => {
      const { count } = await tx.workflowExecution.updateMany({
        where: { id: e.id, status: 'RUNNING', attempt: e.attempt, claimedAt: { lt: stale } },
        data: {
          status: decision.status,
          error: err.message,
          errorKind: 'TRANSIENT',
          claimedAt: null,
          ...(decision.status === 'FAILED'
            ? { nextAttemptAt: now }
            : { nextAttemptAt: null, finishedAt: now }),
        },
      });
      if (count === 1 && decision.status === 'DEAD') {
        await notifyDead(tx, e, e.workflow.name, err.message, now);
      }
    });
  }

  // Queued for a while, or a retry that is due, with no job working on it.
  const waiting = await deps.db.withSystem((tx) =>
    tx.workflowExecution.findMany({
      where: {
        OR: [
          { status: 'QUEUED', updatedAt: { lt: new Date(now.getTime() - 15_000) } },
          { status: 'FAILED', nextAttemptAt: { lte: now } },
        ],
      },
      select: { id: true, manualRetries: true, attempt: true },
      orderBy: { createdAt: 'asc' },
      take: 500,
    }),
  );
  return {
    requeue: waiting.map((w) => ({
      executionId: w.id,
      round: w.manualRetries,
      attempt: w.attempt,
    })),
    interrupted: interrupted.length,
  };
}

// ---------------------------------------------------------------------------
// task.deadline_reached (WF-02)
// ---------------------------------------------------------------------------

/**
 * Raises `task.deadline_reached` once for each next step whose due time has passed: open tasks on
 * open, unarchived leads. `deadlineEventAt` records the due time the event was raised for, so a
 * rescheduled task raises a new one when its new time comes.
 */
export async function raiseDeadlineEvents(db: Db, now: Date): Promise<number> {
  return db.withSystem(async (tx) => {
    const due = await tx.$queryRaw<
      {
        id: string;
        organizationId: string;
        leadId: string;
        assigneeId: string | null;
        dueAt: Date;
        title: string;
        isSample: boolean;
      }[]
    >`
      WITH due AS (
        SELECT t.id, l."isSample"
        FROM "Task" t
        JOIN "Lead" l ON l.id = t."leadId"
        JOIN "PipelineStage" s ON s.id = l."stageId"
        WHERE t.status = 'OPEN'
          AND t."dueAt" <= ${now}
          AND t."deadlineEventAt" IS DISTINCT FROM t."dueAt"
          AND l."archivedAt" IS NULL
          AND s.kind = 'OPEN'
        ORDER BY t."dueAt"
        LIMIT 500
        FOR UPDATE OF t SKIP LOCKED
      )
      UPDATE "Task" t SET "deadlineEventAt" = t."dueAt"
      FROM due WHERE t.id = due.id
      RETURNING t.id, t."organizationId", t."leadId", t."assigneeId", t."dueAt", t.title, due."isSample"`;
    if (due.length === 0) return 0;
    await tx.outboxEvent.createMany({
      data: due.map((t) => ({
        organizationId: t.organizationId,
        type: 'task.deadline_reached',
        aggregateType: 'Task',
        aggregateId: t.id,
        payload: {
          taskId: t.id,
          leadId: t.leadId,
          assigneeId: t.assigneeId,
          title: t.title,
          dueAt: t.dueAt.toISOString(),
          isSample: t.isSample,
        },
        createdAt: now,
      })),
    });
    return due.length;
  });
}
