import type { Prisma, Tx } from '@datoflow/db';
import {
  canSeeLead,
  decideTouch,
  isOverdue,
  leadScope,
  slaDueAt,
  type NextStepRule,
  type Role,
  type StageKind,
} from '@datoflow/domain';
import {
  ErrorCode,
  orgSettingsSchema,
  type CreateTaskInput,
  type NextStepInput,
  type TaskDto,
  type TouchInput,
  type TouchResultDto,
  type UpdateTaskInput,
} from '@datoflow/shared';
import { ApiError } from '../http/errors.js';
import {
  activity,
  refreshLead,
  updateLead,
  type LeadRow,
  type Member,
  type OrgContext,
} from '../leads/lead-service.js';

export const TASK_INCLUDE = {
  lead: { select: { name: true, company: true, ownerId: true } },
  assignee: { select: { name: true } },
} as const;

type TaskRow = Prisma.TaskGetPayload<{ include: typeof TASK_INCLUDE }>;

/** Sales Reps change only tasks assigned to them; everyone else changes any task they can see. */
export function canEditTask(member: Member, task: { assigneeId: string | null }) {
  return member.role !== 'REP' || task.assigneeId === member.userId;
}

export function toTaskDto(task: TaskRow, member: Member, now = new Date()): TaskDto {
  return {
    id: task.id,
    leadId: task.leadId,
    leadName: task.lead.name,
    leadCompany: task.lead.company,
    title: task.title,
    type: task.type,
    dueAt: task.dueAt.toISOString(),
    priority: task.priority,
    assigneeId: task.assigneeId,
    assigneeName: task.assignee?.name ?? null,
    status: task.status,
    overdue: isOverdue(task, now),
    completedAt: task.completedAt?.toISOString() ?? null,
    createdAt: task.createdAt.toISOString(),
    canEdit: canEditTask(member, task),
  };
}

/** A task the member can see (its lead is visible), or 404. */
export async function visibleTask(tx: Tx, member: Member, id: string): Promise<TaskRow> {
  const task = await tx.task.findUnique({ where: { id }, include: TASK_INCLUDE });
  if (!task || !canSeeLead(member.scope, task.lead)) throw ApiError.notFound('Task');
  return task;
}

/**
 * Checks the assignee of a task on `lead` (TASK-01): a member of this organization, and for a
 * Sales Rep someone who can see the lead. Sales Reps assign tasks only to themselves.
 */
async function resolveAssignee(
  tx: Tx,
  org: OrgContext,
  member: Member,
  lead: { ownerId: string | null },
  assigneeId: string | undefined,
  path: string,
): Promise<string> {
  const id = assigneeId ?? member.userId;
  if (member.role === 'REP' && id !== member.userId) {
    throw ApiError.forbidden('Sales Reps can give tasks only to themselves');
  }
  const membership = await tx.organizationMembership.findFirst({
    where: { userId: id },
    select: { role: true },
  });
  if (!membership) {
    throw ApiError.validation([{ path, message: 'Choose a member of this workspace' }]);
  }
  const scope = leadScope(membership.role as Role, id, org.settings);
  if (!canSeeLead(scope, lead)) {
    throw ApiError.validation([
      { path, message: 'This Sales Rep cannot see the lead. Assign the lead to them first' },
    ]);
  }
  return id;
}

async function insertTask(
  tx: Tx,
  org: OrgContext,
  member: Member,
  lead: LeadRow,
  input: NextStepInput,
  path: string,
): Promise<TaskRow> {
  const assigneeId = await resolveAssignee(tx, org, member, lead, input.assigneeId, path);
  const task = await tx.task.create({
    data: {
      organizationId: org.id,
      leadId: lead.id,
      title: input.title,
      type: input.type,
      dueAt: input.dueAt,
      priority: input.priority,
      assigneeId,
      createdById: member.actor.id,
    },
    include: TASK_INCLUDE,
  });
  await activity(tx, org.id, lead.id, member.actor, 'TASK_CREATED', {
    taskId: task.id,
    title: task.title,
    type: task.type,
    dueAt: task.dueAt.toISOString(),
    assigneeId,
  });
  return task;
}

function assertWritableLead(lead: LeadRow) {
  if (lead.archivedAt) throw new ApiError(409, 'CONFLICT', 'Restore the lead before changing it');
}

export async function createTask(
  tx: Tx,
  org: OrgContext,
  member: Member,
  lead: LeadRow,
  input: CreateTaskInput,
): Promise<TaskRow> {
  assertWritableLead(lead);
  const task = await insertTask(tx, org, member, lead, input, 'body.assigneeId');
  await refreshLead(tx, lead.id);
  return task;
}

export async function updateTask(
  tx: Tx,
  org: OrgContext,
  member: Member,
  task: TaskRow,
  input: UpdateTaskInput,
): Promise<TaskRow> {
  if (!canEditTask(member, task)) {
    throw ApiError.forbidden('Sales Reps can change only their own tasks');
  }
  const lead = await tx.lead.findUniqueOrThrow({ where: { id: task.leadId } });
  if (lead.archivedAt) throw new ApiError(409, 'CONFLICT', 'Restore the lead before changing it');
  const assigneeId =
    input.assigneeId !== undefined && input.assigneeId !== task.assigneeId
      ? await resolveAssignee(tx, org, member, lead, input.assigneeId, 'body.assigneeId')
      : undefined;

  const now = new Date();
  const statusChanged = input.status !== undefined && input.status !== task.status;
  const updated = await tx.task.update({
    where: { id: task.id },
    data: {
      ...(input.title !== undefined ? { title: input.title } : {}),
      ...(input.type !== undefined ? { type: input.type } : {}),
      ...(input.dueAt !== undefined ? { dueAt: input.dueAt } : {}),
      ...(input.priority !== undefined ? { priority: input.priority } : {}),
      ...(assigneeId !== undefined ? { assigneeId } : {}),
      ...(statusChanged
        ? { status: input.status, completedAt: input.status === 'DONE' ? now : null }
        : {}),
    },
    include: TASK_INCLUDE,
  });

  const ref = { taskId: task.id, title: updated.title };
  if (statusChanged && updated.status === 'DONE') {
    await activity(tx, org.id, task.leadId, member.actor, 'TASK_COMPLETED', ref);
  } else if (statusChanged && updated.status === 'CANCELLED') {
    await activity(tx, org.id, task.leadId, member.actor, 'TASK_CANCELLED', ref);
  }
  const moved = updated.dueAt.getTime() !== task.dueAt.getTime();
  const reassigned = updated.assigneeId !== task.assigneeId;
  const reopened = statusChanged && updated.status === 'OPEN';
  if (moved || reassigned || reopened || updated.title !== task.title) {
    await activity(tx, org.id, task.leadId, member.actor, 'TASK_UPDATED', {
      ...ref,
      ...(moved ? { fromDueAt: task.dueAt.toISOString(), dueAt: updated.dueAt.toISOString() } : {}),
      ...(reassigned ? { fromAssigneeId: task.assigneeId, assigneeId: updated.assigneeId } : {}),
      ...(reopened ? { reopened: true } : {}),
    });
  }
  await refreshLead(tx, task.leadId, now);
  return updated;
}

/**
 * Logs a touch: a call, email, WhatsApp message or meeting (TASK-02). On an open lead it needs a
 * new next step in the same request, unless `close` moves the lead to Won or Lost. An organization
 * on "warn only" saves the touch anyway and says so.
 */
export async function logTouch(
  tx: Tx,
  org: OrgContext,
  member: Member,
  lead: LeadRow,
  input: TouchInput,
): Promise<TouchResultDto> {
  assertWritableLead(lead);
  let closeKind: StageKind | null = null;
  if (input.close) {
    const stage = await tx.pipelineStage.findUnique({ where: { id: input.close.stageId } });
    if (!stage || stage.kind === 'OPEN') {
      throw ApiError.validation([
        { path: 'body.close.stageId', message: 'Choose the Won or the Lost stage' },
      ]);
    }
    closeKind = stage.kind;
  }
  const kindAfter = closeKind ?? lead.stage.kind;
  if (input.nextStep && kindAfter !== 'OPEN') {
    throw ApiError.validation([
      { path: 'body.nextStep', message: 'A closed lead needs no next step' },
    ]);
  }
  const rule: NextStepRule = orgSettingsSchema.parse(org.settings).nextStepRule ?? 'require';
  const decision = decideTouch({ kindAfter, hasNewNextStep: Boolean(input.nextStep), rule });
  if (!decision.ok) {
    throw new ApiError(422, ErrorCode.NEXT_STEP_REQUIRED, decision.message, {
      errors: [{ path: decision.path, message: decision.message }],
    });
  }

  // Tasks the touch took care of: open tasks on this lead that the member may change.
  const done = input.completeTaskIds?.length
    ? await tx.task.findMany({ where: { id: { in: input.completeTaskIds }, leadId: lead.id } })
    : [];
  if (
    done.length !== (input.completeTaskIds?.length ?? 0) ||
    done.some((t) => t.status !== 'OPEN')
  ) {
    throw ApiError.validation([
      { path: 'body.completeTaskIds', message: 'Choose open tasks on this lead' },
    ]);
  }
  if (done.some((t) => !canEditTask(member, t))) {
    throw ApiError.forbidden('Sales Reps can complete only their own tasks');
  }

  const now = new Date();
  const touch = await tx.leadActivity.create({
    data: {
      organizationId: org.id,
      leadId: lead.id,
      type: 'TOUCH',
      actorType: member.actor.type,
      actorId: member.actor.id,
      actorLabel: member.actor.label,
      payload: {
        channel: input.channel,
        ...(input.text ? { text: input.text } : {}),
        ...(decision.warning ? { warning: decision.warning } : {}),
      },
      occurredAt: now,
    },
  });
  // A touch is follow-up: it restarts the stage SLA clock.
  await tx.lead.update({
    where: { id: lead.id },
    data: {
      lastActivityAt: now,
      slaDueAt: slaDueAt(now, lead.stage.slaHours, lead.stage.kind),
    },
  });
  for (const t of done) {
    await tx.task.update({ where: { id: t.id }, data: { status: 'DONE', completedAt: now } });
    await activity(tx, org.id, lead.id, member.actor, 'TASK_COMPLETED', {
      taskId: t.id,
      title: t.title,
    });
  }
  let nextStep: TaskRow | null = null;
  if (input.nextStep) {
    nextStep = await insertTask(tx, org, member, lead, input.nextStep, 'body.nextStep.assigneeId');
  }
  if (input.close) {
    const fresh = await refreshLead(tx, lead.id, now);
    await updateLead(tx, org, member, fresh, {
      stageId: input.close.stageId,
      ...(input.close.lossReasonId !== undefined ? { lossReasonId: input.close.lossReasonId } : {}),
      ...(input.close.dealValue !== undefined ? { dealValue: input.close.dealValue } : {}),
    });
  } else {
    await refreshLead(tx, lead.id, now);
  }
  return {
    activityId: touch.id,
    nextStep: nextStep ? toTaskDto(nextStep, member, now) : null,
    warning: decision.warning,
  };
}
