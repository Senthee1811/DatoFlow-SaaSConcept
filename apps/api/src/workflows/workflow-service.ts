import type { Tx } from '@datoflow/db';
import { checkLimit } from '@datoflow/domain';
import {
  ErrorCode,
  type DefinitionInput,
  type ExecutionDetailDto,
  type ExecutionDto,
  type WorkflowDto,
  type WorkflowStatusCode,
  type WorkflowSummaryDto,
  type WorkflowVersionDto,
} from '@datoflow/shared';
import {
  canRetryManually,
  checkDefinition,
  CANCELLABLE,
  UNASSIGNED,
  type Action,
  type Condition,
  type Definition,
  type ExecutionStatus,
  type SkipReason,
  type Trigger,
} from '@datoflow/workflow';
import { ApiError } from '../http/errors.js';

const RUN_WINDOW_DAYS = 30;

/**
 * Checks a definition before it is saved (WF-01, WF-04): the rules in packages/workflow, then
 * every stage and member it names. Actions may move a lead only to an open stage.
 */
export async function assertDefinition(tx: Tx, def: DefinitionInput): Promise<Definition> {
  const errors = checkDefinition(def).map((e) => ({
    path: `body.definition.${e.path}`,
    message: e.message,
  }));

  const stageIds = new Set<string>();
  const userIds = new Set<string>();
  def.conditions.forEach((c) => {
    if (c.field === 'stage') c.values.forEach((v) => stageIds.add(v));
    if (c.field === 'assignee')
      c.values.filter((v) => v !== UNASSIGNED).forEach((v) => userIds.add(v));
  });
  def.actions.forEach((a) => {
    if (a.type === 'assign') a.userIds.forEach((v) => userIds.add(v));
    if (a.type === 'create_task' && a.assigneeId) userIds.add(a.assigneeId);
    if (a.type === 'notify' && a.userId) userIds.add(a.userId);
    if (a.type === 'update_field' && a.field === 'owner' && a.value) userIds.add(a.value);
    if (a.type === 'update_field' && a.field === 'stage') stageIds.add(a.value);
  });

  const [stages, members] = await Promise.all([
    stageIds.size
      ? tx.pipelineStage.findMany({
          where: { id: { in: [...stageIds] } },
          select: { id: true, kind: true },
        })
      : [],
    userIds.size
      ? tx.organizationMembership.findMany({
          where: { userId: { in: [...userIds] } },
          select: { userId: true },
        })
      : [],
  ]);
  const stageKind = new Map(stages.map((s) => [s.id, s.kind]));
  const isMember = new Set(members.map((m) => m.userId));
  const memberError = (path: string, ids: (string | null)[]) => {
    if (ids.some((id) => id && !isMember.has(id))) {
      errors.push({ path, message: 'Choose members of this workspace' });
    }
  };

  def.conditions.forEach((c, i) => {
    const path = `body.definition.conditions.${i}.values`;
    if (c.field === 'stage' && c.values.some((v) => !stageKind.has(v))) {
      errors.push({ path, message: 'Choose stages from this pipeline' });
    }
    if (c.field === 'assignee')
      memberError(
        path,
        c.values.filter((v) => v !== UNASSIGNED),
      );
  });
  def.actions.forEach((a, i) => {
    const path = `body.definition.actions.${i}`;
    if (a.type === 'assign') memberError(`${path}.userIds`, a.userIds);
    if (a.type === 'create_task') memberError(`${path}.assigneeId`, [a.assigneeId]);
    if (a.type === 'notify') memberError(`${path}.userId`, [a.userId]);
    if (a.type === 'update_field' && a.field === 'owner') memberError(`${path}.value`, [a.value]);
    if (a.type === 'update_field' && a.field === 'stage') {
      const kind = stageKind.get(a.value);
      if (!kind)
        errors.push({ path: `${path}.value`, message: 'Choose a stage from this pipeline' });
      else if (kind !== 'OPEN') {
        errors.push({
          path: `${path}.value`,
          message: 'Workflows can move leads only to open stages. Won and Lost need a person',
        });
      }
    }
  });

  if (errors.length) throw ApiError.validation(errors);
  return def as Definition;
}

type WorkflowRow = {
  id: string;
  organizationId: string;
  name: string;
  status: WorkflowStatusCode;
  activeVersionId: string | null;
  latestVersion: number;
  isSample: boolean;
  createdAt: Date;
  updatedAt: Date;
};

type VersionRow = {
  id: string;
  workflowId: string;
  version: number;
  trigger: string;
  conditions: unknown;
  actions: unknown;
  createdById: string | null;
  createdAt: Date;
};

function definitionOf(v: VersionRow): Definition {
  return {
    trigger: v.trigger as Trigger,
    conditions: v.conditions as Condition[],
    actions: v.actions as Action[],
  };
}

/** Summaries for a list of workflows: latest trigger, active version and recent runs. */
export async function summarise(tx: Tx, rows: WorkflowRow[], now = new Date()) {
  const ids = rows.map((w) => w.id);
  if (ids.length === 0) return new Map<string, WorkflowSummaryDto>();
  const since = new Date(now.getTime() - RUN_WINDOW_DAYS * 86_400_000);
  const [versions, counts, last] = await Promise.all([
    tx.workflowVersion.findMany({
      where: {
        OR: [
          ...rows.map((w) => ({ workflowId: w.id, version: w.latestVersion })),
          ...rows.filter((w) => w.activeVersionId).map((w) => ({ id: w.activeVersionId! })),
        ],
      },
      select: { id: true, workflowId: true, version: true, trigger: true },
    }),
    tx.workflowExecution.groupBy({
      by: ['workflowId', 'status'],
      where: { workflowId: { in: ids }, createdAt: { gte: since } },
      _count: { _all: true },
    }),
    tx.workflowExecution.groupBy({
      by: ['workflowId'],
      where: { workflowId: { in: ids }, status: { not: 'SKIPPED' } },
      _max: { createdAt: true },
    }),
  ]);
  const result = new Map<string, WorkflowSummaryDto>();
  for (const w of rows) {
    const latest = versions.find((v) => v.workflowId === w.id && v.version === w.latestVersion);
    const active = w.activeVersionId ? versions.find((v) => v.id === w.activeVersionId) : null;
    const count = (statuses: ExecutionStatus[]) =>
      counts
        .filter((c) => c.workflowId === w.id && statuses.includes(c.status))
        .reduce((n, c) => n + c._count._all, 0);
    result.set(w.id, {
      id: w.id,
      name: w.name,
      status: w.status,
      trigger: (latest?.trigger ?? 'lead.created') as Trigger,
      latestVersion: w.latestVersion,
      activeVersion: w.status === 'ACTIVE' ? (active?.version ?? null) : null,
      isSample: w.isSample,
      runs: {
        succeeded: count(['SUCCEEDED']),
        failed: count(['FAILED', 'DEAD']),
        skipped: count(['SKIPPED']),
      },
      lastRunAt: last.find((l) => l.workflowId === w.id)?._max.createdAt?.toISOString() ?? null,
      createdAt: w.createdAt.toISOString(),
      updatedAt: w.updatedAt.toISOString(),
    });
  }
  return result;
}

export async function findWorkflow(tx: Tx, id: string) {
  const workflow = await tx.workflow.findUnique({ where: { id } });
  if (!workflow) throw ApiError.notFound('Workflow');
  return workflow;
}

export async function toWorkflowDto(tx: Tx, w: WorkflowRow): Promise<WorkflowDto> {
  const summary = (await summarise(tx, [w])).get(w.id)!;
  const versions = (await tx.workflowVersion.findMany({
    where: { workflowId: w.id },
    orderBy: { version: 'desc' },
    take: 50,
  })) as VersionRow[];
  const authors = await tx.user.findMany({
    where: { id: { in: versions.map((v) => v.createdById).filter((x): x is string => !!x) } },
    select: { id: true, name: true },
  });
  const nameOf = new Map(authors.map((u) => [u.id, u.name]));
  const toVersion = (v: VersionRow): WorkflowVersionDto => ({
    id: v.id,
    version: v.version,
    definition: definitionOf(v),
    createdAt: v.createdAt.toISOString(),
    createdByName: v.createdById ? (nameOf.get(v.createdById) ?? null) : null,
  });
  return {
    ...summary,
    definition: definitionOf(versions[0]!),
    versions: versions.map(toVersion),
  };
}

/** Saves a new immutable version (WF-01). An active workflow runs the new version from now on. */
export async function saveVersion(
  tx: Tx,
  workflow: WorkflowRow,
  def: Definition,
  userId: string,
  name?: string,
) {
  const version = workflow.latestVersion + 1;
  const saved = await tx.workflowVersion.create({
    data: {
      organizationId: workflow.organizationId,
      workflowId: workflow.id,
      version,
      trigger: def.trigger,
      conditions: def.conditions as object[],
      actions: def.actions as object[],
      createdById: userId,
    },
  });
  // The unique (workflowId, version) makes two saves at once fail rather than share a number.
  return tx.workflow.update({
    where: { id: workflow.id, latestVersion: workflow.latestVersion },
    data: {
      latestVersion: version,
      ...(name ? { name } : {}),
      ...(workflow.status === 'ACTIVE' ? { activeVersionId: saved.id } : {}),
    },
  });
}

/**
 * Activates or resumes a workflow with its latest version (WF-05). Sample workflows never count
 * against the plan's active-workflow limit; real ones do (402 with the limit's name).
 */
export async function activate(tx: Tx, workflow: WorkflowRow, planCode: string) {
  if (!workflow.isSample) {
    const active = await tx.workflow.count({
      where: { status: 'ACTIVE', isSample: false, id: { not: workflow.id } },
    });
    const check = checkLimit(planCode, 'activeWorkflows', active);
    if (!check.ok) {
      throw new ApiError(
        402,
        ErrorCode.PLAN_LIMIT_REACHED,
        `Your plan includes ${check.max} active ${check.max === 1 ? 'workflow' : 'workflows'}. Pause one or upgrade to activate this one`,
        { limit: check.limit },
      );
    }
  }
  const latest = await tx.workflowVersion.findUniqueOrThrow({
    where: { workflowId_version: { workflowId: workflow.id, version: workflow.latestVersion } },
    select: { id: true },
  });
  return tx.workflow.update({
    where: { id: workflow.id },
    data: { status: 'ACTIVE', activeVersionId: latest.id },
  });
}

/** Pauses a workflow. Runs still waiting (queued, or failed with a retry due) are cancelled (WF-05). */
export async function pause(tx: Tx, workflow: WorkflowRow, now = new Date()) {
  const updated = await tx.workflow.update({
    where: { id: workflow.id },
    data: { status: 'PAUSED' },
  });
  const { count } = await tx.workflowExecution.updateMany({
    where: { workflowId: workflow.id, status: { in: [...CANCELLABLE] } },
    data: {
      status: 'CANCELLED',
      finishedAt: now,
      nextAttemptAt: null,
      error: 'The workflow was paused',
    },
  });
  return { workflow: updated, cancelled: count };
}

// ---------------------------------------------------------------------------
// Executions (WF-06)
// ---------------------------------------------------------------------------

export const EXECUTION_INCLUDE = {
  workflow: { select: { name: true, status: true } },
  version: { select: { version: true, actions: true } },
} as const;

type ExecutionRow = {
  id: string;
  workflowId: string;
  eventId: string;
  eventType: string;
  leadId: string | null;
  status: ExecutionStatus;
  attempt: number;
  depth: number;
  skipReason: string | null;
  error: string | null;
  errorKind: string | null;
  nextAttemptAt: Date | null;
  startedAt: Date | null;
  finishedAt: Date | null;
  createdAt: Date;
  manualRetries: number;
  workflow: { name: string; status: WorkflowStatusCode };
  version: { version: number; actions: unknown };
};

export async function leadNames(tx: Tx, rows: { leadId: string | null }[]) {
  const ids = [...new Set(rows.map((r) => r.leadId).filter((x): x is string => !!x))];
  const leads = ids.length
    ? await tx.lead.findMany({ where: { id: { in: ids } }, select: { id: true, name: true } })
    : [];
  return new Map(leads.map((l) => [l.id, l.name]));
}

export function toExecutionDto(e: ExecutionRow, names: Map<string, string>): ExecutionDto {
  return {
    id: e.id,
    workflowId: e.workflowId,
    workflowName: e.workflow.name,
    version: e.version.version,
    eventId: e.eventId,
    eventType: e.eventType,
    leadId: e.leadId,
    leadName: e.leadId ? (names.get(e.leadId) ?? null) : null,
    status: e.status,
    attempt: e.attempt,
    depth: e.depth,
    skipReason: (e.skipReason as SkipReason | null) ?? null,
    error: e.error,
    errorKind: e.errorKind,
    nextAttemptAt: e.nextAttemptAt?.toISOString() ?? null,
    startedAt: e.startedAt?.toISOString() ?? null,
    finishedAt: e.finishedAt?.toISOString() ?? null,
    createdAt: e.createdAt.toISOString(),
    canRetry: canRetryManually(e.status),
  };
}

export async function toExecutionDetail(tx: Tx, e: ExecutionRow): Promise<ExecutionDetailDto> {
  const steps = await tx.workflowExecutionStep.findMany({
    where: { executionId: e.id },
    orderBy: { stepIndex: 'asc' },
  });
  return {
    ...toExecutionDto(e, await leadNames(tx, [e])),
    manualRetries: e.manualRetries,
    actions: e.version.actions as Action[],
    steps: steps.map((s) => ({
      stepIndex: s.stepIndex,
      actionType: s.actionType,
      status: s.status,
      attempt: s.attempt,
      result: (s.result as Record<string, unknown> | null) ?? null,
      error: s.error,
      finishedAt: s.finishedAt.toISOString(),
    })),
  };
}

/**
 * A manual retry (WF-06): only for FAILED or DEAD runs of an active workflow. The run goes back to
 * the queue with a fresh set of attempts; steps that already succeeded are not repeated.
 */
export async function retryExecution(tx: Tx, e: ExecutionRow) {
  if (!canRetryManually(e.status)) {
    throw new ApiError(409, ErrorCode.CONFLICT, 'Only failed or dead runs can be retried');
  }
  if (e.workflow.status !== 'ACTIVE') {
    throw new ApiError(409, ErrorCode.CONFLICT, 'Resume the workflow before retrying its runs');
  }
  const { count } = await tx.workflowExecution.updateMany({
    where: { id: e.id, status: e.status },
    data: {
      status: 'QUEUED',
      attempt: 0,
      nextAttemptAt: null,
      claimedAt: null,
      finishedAt: null,
      manualRetries: { increment: 1 },
    },
  });
  if (count !== 1)
    throw new ApiError(409, ErrorCode.CONFLICT, 'The run changed. Reload and try again');
  return tx.workflowExecution.findUniqueOrThrow({
    where: { id: e.id },
    include: EXECUTION_INCLUDE,
  });
}
