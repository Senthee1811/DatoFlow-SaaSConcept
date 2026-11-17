import { refreshLeads, type Tx } from '@datoflow/db';
import { slaDueAt, type ActivityType } from '@datoflow/domain';
import {
  ActionError,
  applyTags,
  pickRoundRobin,
  renderTemplate,
  stepKey,
  type Action,
} from '@datoflow/workflow';
import { KIND } from '../jobs/scan.js';

/** Notification kinds written by workflows. */
export const WORKFLOW_KIND = {
  MESSAGE: 'WORKFLOW_MESSAGE',
  DEAD: 'WORKFLOW_DEAD',
} as const;

/** Everything an action needs about the run that is executing it. */
export interface RunContext {
  executionId: string;
  workflowId: string;
  workflowName: string;
  organizationId: string;
  orgName: string;
  leadId: string;
  /** Depth of the event that started the run; events raised here are one deeper (WF-09). */
  depth: number;
  attempt: number;
  now: Date;
}

const LEAD_INCLUDE = {
  stage: { select: { kind: true, slaHours: true } },
  owner: { select: { name: true } },
} as const;

async function loadLead(tx: Tx, ctx: RunContext) {
  const lead = await tx.lead.findUnique({ where: { id: ctx.leadId }, include: LEAD_INCLUDE });
  if (!lead) throw new ActionError('NOT_FOUND', 'The lead no longer exists');
  return lead;
}
type Lead = Awaited<ReturnType<typeof loadLead>>;

function actor(ctx: RunContext) {
  return { actorType: 'WORKFLOW' as const, actorId: ctx.workflowId, actorLabel: ctx.workflowName };
}

async function activity(
  tx: Tx,
  ctx: RunContext,
  type: ActivityType,
  payload: Record<string, unknown>,
) {
  await tx.leadActivity.create({
    data: {
      organizationId: ctx.organizationId,
      leadId: ctx.leadId,
      type,
      ...actor(ctx),
      payload: { ...payload, executionId: ctx.executionId } as object,
      occurredAt: ctx.now,
    },
  });
}

/** An event raised by a workflow: one level deeper, caused by this run (WF-09). */
async function outbox(
  tx: Tx,
  ctx: RunContext,
  type: 'lead.stage_changed' | 'lead.assigned',
  payload: Record<string, unknown>,
) {
  await tx.outboxEvent.create({
    data: {
      organizationId: ctx.organizationId,
      type,
      aggregateType: 'Lead',
      aggregateId: ctx.leadId,
      payload: payload as object,
      depth: ctx.depth + 1,
      causationId: ctx.executionId,
    },
  });
}

async function memberIds(tx: Tx, userIds: string[]): Promise<Set<string>> {
  if (userIds.length === 0) return new Set();
  const rows = await tx.organizationMembership.findMany({
    where: { userId: { in: userIds } },
    select: { userId: true },
  });
  return new Set(rows.map((r) => r.userId));
}

async function requireMember(tx: Tx, userId: string, what: string) {
  if (!(await memberIds(tx, [userId])).has(userId)) {
    throw new ActionError('VALIDATION', `${what} is no longer a member of this workspace`);
  }
}

/** Sets the owner like a person's reassignment: restarts the SLA clock, timeline, event. */
async function setOwner(tx: Tx, ctx: RunContext, lead: Lead, ownerId: string | null) {
  if (lead.ownerId === ownerId) return { ownerId, unchanged: true };
  await tx.lead.update({
    where: { id: lead.id },
    data: {
      ownerId,
      lastActivityAt: ctx.now,
      slaDueAt: slaDueAt(ctx.now, lead.stage.slaHours, lead.stage.kind),
    },
  });
  await activity(tx, ctx, 'ASSIGNED', { fromOwnerId: lead.ownerId, toOwnerId: ownerId });
  await outbox(tx, ctx, 'lead.assigned', {
    leadId: lead.id,
    fromOwnerId: lead.ownerId,
    toOwnerId: ownerId,
    isSample: lead.isSample,
  });
  return { ownerId, unchanged: false };
}

function templateValues(ctx: RunContext, lead: Lead) {
  return {
    'lead.name': lead.name,
    'lead.company': lead.company,
    'owner.name': lead.owner?.name ?? null,
    'org.name': ctx.orgName,
  };
}

/**
 * Performs one action inside the run's tenant transaction. The caller writes the step row in the
 * same transaction, so the effect and its record commit together or not at all (WF-07).
 * Returns what the step log shows.
 */
export async function performAction(
  tx: Tx,
  ctx: RunContext,
  action: Action,
  stepIndex: number,
): Promise<Record<string, unknown>> {
  const lead = await loadLead(tx, ctx);
  const key = stepKey(ctx.executionId, stepIndex);

  switch (action.type) {
    case 'assign': {
      let userId: string;
      if (action.mode === 'user') {
        userId = action.userIds[0]!;
        await requireMember(tx, userId, 'The chosen member');
      } else {
        const members = await memberIds(tx, action.userIds);
        const wf = await tx.workflow.findUniqueOrThrow({
          where: { id: ctx.workflowId },
          select: { roundRobinCursor: true },
        });
        const pick = pickRoundRobin(action.userIds, wf.roundRobinCursor, (u) => members.has(u));
        if (!pick) {
          throw new ActionError(
            'VALIDATION',
            'None of the round-robin members is still in the workspace',
          );
        }
        // Moves with the step: if the step rolls back, the turn is not used up.
        await tx.workflow.update({
          where: { id: ctx.workflowId },
          data: { roundRobinCursor: pick.cursor },
        });
        userId = pick.userId;
      }
      const result = await setOwner(tx, ctx, lead, userId);
      await refreshLeads(tx, [lead.id], ctx.now);
      return { ...result, mode: action.mode };
    }

    case 'create_task': {
      const assigneeId = action.assigneeId ?? lead.ownerId;
      if (!assigneeId) {
        throw new ActionError('VALIDATION', 'The lead has no owner to give the task to');
      }
      await requireMember(tx, assigneeId, 'The assignee');
      const dueAt = new Date(ctx.now.getTime() + action.dueInHours * 3_600_000);
      const task = await tx.task.create({
        data: {
          organizationId: ctx.organizationId,
          leadId: lead.id,
          title: action.title,
          type: action.taskType,
          dueAt,
          priority: action.priority,
          assigneeId,
        },
      });
      await activity(tx, ctx, 'TASK_CREATED', {
        taskId: task.id,
        title: task.title,
        type: task.type,
        dueAt: dueAt.toISOString(),
        assigneeId,
      });
      await refreshLeads(tx, [lead.id], ctx.now);
      return { taskId: task.id, assigneeId, dueAt: dueAt.toISOString() };
    }

    case 'send_email': {
      const values = templateValues(ctx, lead);
      let target: { userId: string | null; toAddress: string | null };
      if (action.to === 'lead') {
        if (!lead.email) throw new ActionError('VALIDATION', 'The lead has no email address');
        target = { userId: null, toAddress: lead.email };
      } else {
        if (!lead.ownerId) throw new ActionError('VALIDATION', 'The lead has no owner to email');
        target = { userId: lead.ownerId, toAddress: null };
      }
      const sendAfter = new Date(ctx.now.getTime() + action.delayMinutes * 60_000);
      // Keyed by run and step: however often this step runs, there is one email (WF-07).
      await tx.notification.createMany({
        data: [
          {
            organizationId: ctx.organizationId,
            ...target,
            kind: KIND.WORKFLOW_EMAIL,
            channel: 'EMAIL',
            status: 'PENDING',
            dedupeKey: key,
            sendAfter,
            payload: {
              subject: renderTemplate(action.subject, values),
              body: renderTemplate(action.body, values),
              leadId: lead.id,
              workflowId: ctx.workflowId,
              executionId: ctx.executionId,
            },
            createdAt: ctx.now,
          },
        ],
        skipDuplicates: true,
      });
      await activity(tx, ctx, 'WORKFLOW_ACTION', {
        action: 'send_email',
        to: action.to,
        subject: renderTemplate(action.subject, values),
        sendAfter: sendAfter.toISOString(),
      });
      return { to: action.to, sendAfter: sendAfter.toISOString(), key };
    }

    case 'notify': {
      let userIds: string[];
      if (action.to === 'owner') {
        if (!lead.ownerId) throw new ActionError('VALIDATION', 'The lead has no owner to notify');
        userIds = [lead.ownerId];
      } else if (action.to === 'user') {
        await requireMember(tx, action.userId!, 'The member to notify');
        userIds = [action.userId!];
      } else {
        const admins = await tx.organizationMembership.findMany({
          where: { role: { in: ['OWNER', 'ADMIN'] }, isSample: false },
          select: { userId: true },
        });
        userIds = admins.map((a) => a.userId);
      }
      const message = renderTemplate(action.message, templateValues(ctx, lead));
      await tx.notification.createMany({
        data: userIds.map((userId) => ({
          organizationId: ctx.organizationId,
          userId,
          kind: WORKFLOW_KIND.MESSAGE,
          channel: 'IN_APP' as const,
          status: 'SENT' as const,
          sentAt: ctx.now,
          dedupeKey: `${key}:${userId}`,
          payload: {
            message,
            leadId: lead.id,
            leadName: lead.name,
            workflowId: ctx.workflowId,
            workflowName: ctx.workflowName,
          },
          createdAt: ctx.now,
        })),
        skipDuplicates: true,
      });
      await activity(tx, ctx, 'WORKFLOW_ACTION', {
        action: 'notify',
        to: action.to,
        message,
        recipients: userIds.length,
      });
      return { to: action.to, recipients: userIds.length };
    }

    case 'update_field': {
      switch (action.field) {
        case 'owner': {
          if (action.value) await requireMember(tx, action.value, 'The new owner');
          const result = await setOwner(tx, ctx, lead, action.value);
          await refreshLeads(tx, [lead.id], ctx.now);
          return { field: 'owner', ...result };
        }
        case 'priority': {
          if (lead.priority === action.value) return { field: 'priority', unchanged: true };
          await tx.lead.update({ where: { id: lead.id }, data: { priority: action.value } });
          await activity(tx, ctx, 'UPDATED', {
            changes: [{ field: 'priority', from: lead.priority, to: action.value }],
          });
          return { field: 'priority', from: lead.priority, to: action.value };
        }
        case 'tags': {
          const tags = applyTags(lead.tags, action.op, action.value);
          if (JSON.stringify(tags) === JSON.stringify(lead.tags)) {
            return { field: 'tags', unchanged: true };
          }
          await tx.lead.update({ where: { id: lead.id }, data: { tags } });
          await activity(tx, ctx, 'UPDATED', {
            changes: [{ field: 'tags', from: lead.tags, to: tags }],
          });
          return { field: 'tags', tags };
        }
        case 'stage': {
          if (lead.stageId === action.value) return { field: 'stage', unchanged: true };
          const stage = await tx.pipelineStage.findUnique({ where: { id: action.value } });
          if (!stage) throw new ActionError('VALIDATION', 'The stage no longer exists');
          if (stage.kind !== 'OPEN') {
            throw new ActionError('VALIDATION', 'Workflows can move leads only to open stages');
          }
          await tx.lead.update({
            where: { id: lead.id },
            data: {
              stageId: stage.id,
              pipelineId: stage.pipelineId,
              stageEnteredAt: ctx.now,
              closedAt: null,
              lossReasonId: null,
              lastActivityAt: ctx.now,
              slaDueAt: slaDueAt(ctx.now, stage.slaHours, stage.kind),
            },
          });
          await tx.stageHistory.create({
            data: {
              organizationId: ctx.organizationId,
              leadId: lead.id,
              fromStageId: lead.stageId,
              toStageId: stage.id,
              enteredAt: ctx.now,
            },
          });
          await activity(tx, ctx, 'STAGE_CHANGED', {
            fromStageId: lead.stageId,
            toStageId: stage.id,
          });
          await outbox(tx, ctx, 'lead.stage_changed', {
            leadId: lead.id,
            fromStageId: lead.stageId,
            toStageId: stage.id,
            toKind: stage.kind,
            ownerId: lead.ownerId,
            isSample: lead.isSample,
          });
          await refreshLeads(tx, [lead.id], ctx.now);
          return { field: 'stage', from: lead.stageId, to: stage.id };
        }
      }
    }
  }
}
