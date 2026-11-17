import { refreshNextSteps, runRadar, type Tx } from '@datoflow/db';
import {
  buildSampleWorkspace,
  duplicateReason,
  nameCompanyKey,
  normaliseLeadEmail,
  normalisePhone,
  sampleDealValue,
  sampleNextSteps,
  slaDueAt,
} from '@datoflow/domain';
import type { Definition } from '@datoflow/workflow';
import { randomUUID } from 'node:crypto';

const HOUR = 60 * 60 * 1000;

/** Sample reps cannot sign in: they have no password and an unroutable address. */
export function sampleRepEmail(local: string, organizationId: string) {
  return `${local}.${organizationId}@sample.datoflow.invalid`;
}

/**
 * Fills a new organization with the sample agency (ORG-04). Runs in the organization's creation
 * transaction. Every record is marked isSample. No outbox events: sample leads must never
 * trigger automation of their own accord.
 */
export async function seedSampleWorkspace(
  tx: Tx,
  org: { id: string; currency: string; country: string },
  now = new Date(),
) {
  const sample = buildSampleWorkspace();
  const stages = await tx.pipelineStage.findMany({
    where: { organizationId: org.id, pipeline: { isDefault: true } },
    orderBy: { order: 'asc' },
  });
  const reasons = await tx.lossReason.findMany({
    where: { organizationId: org.id },
    orderBy: { order: 'asc' },
  });

  const repIds = sample.reps.map(() => randomUUID());
  await tx.user.createMany({
    data: sample.reps.map((rep, i) => ({
      id: repIds[i]!,
      name: rep.name,
      email: sampleRepEmail(rep.emailLocal, org.id),
      emailVerified: false,
    })),
  });
  await tx.organizationMembership.createMany({
    data: repIds.map((userId) => ({
      organizationId: org.id,
      userId,
      role: 'REP' as const,
      isSample: true,
    })),
  });

  const ago = (hours: number) => new Date(now.getTime() - hours * HOUR);
  const leads = sample.leads.map((l) => {
    const stage = stages[l.stageIndex]!;
    const email = normaliseLeadEmail(l.email);
    const phone = normalisePhone(l.phone, 'LK');
    const lastActivityAt = ago(l.lastActivityHoursAgo);
    return {
      id: randomUUID(),
      organizationId: org.id,
      pipelineId: stage.pipelineId,
      stageId: stage.id,
      ownerId: l.ownerIndex === null ? null : repIds[l.ownerIndex]!,
      name: l.name,
      company: l.company,
      email: l.email,
      emailNormalized: 'value' in email ? email.value : null,
      phone: l.phone,
      phoneE164: 'value' in phone ? phone.value : null,
      nameCompanyKey: nameCompanyKey(l.name, l.company),
      source: l.source,
      priority: l.priority,
      dealValue: sampleDealValue(l.dealValue, org.currency),
      currency: org.currency,
      notes: l.notes,
      utm: l.utm ?? undefined,
      lossReasonId: l.lossReasonIndex === null ? null : (reasons[l.lossReasonIndex]?.id ?? null),
      isSample: true,
      stageEnteredAt: lastActivityAt,
      lastActivityAt,
      slaDueAt: slaDueAt(lastActivityAt, stage.slaHours, stage.kind),
      closedAt: stage.kind === 'OPEN' ? null : lastActivityAt,
      createdAt: ago(l.createdHoursAgo),
    };
  });
  await tx.lead.createMany({ data: leads });

  await tx.stageHistory.createMany({
    data: leads.map((l) => ({
      organizationId: org.id,
      leadId: l.id,
      toStageId: l.stageId,
      enteredAt: l.stageEnteredAt,
    })),
  });
  const system = { actorType: 'SYSTEM' as const, actorLabel: 'Sample data' };
  await tx.leadActivity.createMany({
    data: leads.flatMap((l, i) => [
      {
        organizationId: org.id,
        leadId: l.id,
        type: 'CREATED',
        ...system,
        payload: { source: l.source },
        occurredAt: l.createdAt,
      },
      ...sample.leads[i]!.timeline.map((t) => ({
        organizationId: org.id,
        leadId: l.id,
        type: 'NOTE',
        actorType: 'USER' as const,
        actorId: l.ownerId,
        actorLabel: l.ownerId ? sample.reps[repIds.indexOf(l.ownerId)]!.name : 'Sample data',
        payload: { text: t.text },
        occurredAt: ago(t.hoursAgo),
      })),
    ]),
  });

  const duplicates: {
    organizationId: string;
    leadId: string;
    candidateId: string;
    reason: 'EMAIL' | 'PHONE' | 'NAME_COMPANY';
  }[] = [];
  leads.forEach((a, i) =>
    leads.slice(0, i).forEach((b) => {
      const reason = duplicateReason(a, b);
      if (reason)
        duplicates.push({ organizationId: org.id, leadId: a.id, candidateId: b.id, reason });
    }),
  );
  if (duplicates.length) await tx.leadDuplicate.createMany({ data: duplicates });

  // Open, assigned sample leads get a next step from their rep. Some are overdue, so the radar
  // and My day have something to show; a few have none, which the radar also catches by SLA.
  const steps = sampleNextSteps(sample.leads, now);
  await tx.task.createMany({
    data: steps.map((step) => {
      const lead = leads[step.leadIndex]!;
      return {
        organizationId: org.id,
        leadId: lead.id,
        title: step.title,
        type: step.type,
        dueAt: step.dueAt,
        priority: lead.priority,
        assigneeId: lead.ownerId,
        createdAt: lead.lastActivityAt,
        // Steps already overdue were "reported" before the workspace existed, so the sample
        // deadline workflow fires only as later steps come due, not for every lead at once.
        deadlineEventAt: step.dueAt.getTime() <= now.getTime() ? step.dueAt : null,
      };
    }),
  });
  const ids = leads.map((l) => l.id);
  await refreshNextSteps(tx, { leadIds: ids, organizationId: org.id });
  await runRadar(tx, now, { leadIds: ids, organizationId: org.id });
  const workflows = await seedSampleWorkflows(tx, org.id, stages);
  return { leads: leads.length, reps: repIds.length, workflows };
}

/**
 * The 2 sample workflows (ORG-04). They are active but run on sample leads only, never count
 * against the plan, and go with "Delete sample data". Both fire from things a visitor does or
 * sees: moving a sample lead to Proposal, and a sample next step reaching its due time.
 */
export function sampleWorkflowDefinitions(proposalStageId: string): {
  name: string;
  definition: Definition;
}[] {
  return [
    {
      name: 'Proposal follow-up',
      definition: {
        trigger: 'lead.stage_changed',
        conditions: [{ field: 'stage', operator: 'is', values: [proposalStageId] }],
        actions: [
          {
            type: 'create_task',
            title: 'Follow up on the proposal',
            taskType: 'EMAIL',
            dueInHours: 48,
            priority: 'HIGH',
            assigneeId: null,
          },
          {
            type: 'notify',
            to: 'owner',
            userId: null,
            message: '{{lead.name}} reached Proposal. A follow-up is due in 2 days.',
          },
        ],
      },
    },
    {
      name: 'Escalate missed next steps',
      definition: {
        trigger: 'task.deadline_reached',
        conditions: [],
        actions: [
          { type: 'update_field', field: 'tags', op: 'add', value: ['overdue'] },
          {
            type: 'notify',
            to: 'owner',
            userId: null,
            message: 'A next step for {{lead.name}} is now overdue.',
          },
        ],
      },
    },
  ];
}

async function seedSampleWorkflows(
  tx: Tx,
  organizationId: string,
  stages: { id: string; name: string; kind: string }[],
) {
  const proposal =
    stages.find((s) => s.kind === 'OPEN' && s.name === 'Proposal') ??
    stages.filter((s) => s.kind === 'OPEN').at(-1)!;
  for (const { name, definition } of sampleWorkflowDefinitions(proposal.id)) {
    const workflowId = randomUUID();
    const versionId = randomUUID();
    await tx.workflow.create({
      data: {
        id: workflowId,
        organizationId,
        name,
        status: 'ACTIVE',
        isSample: true,
        latestVersion: 1,
      },
    });
    await tx.workflowVersion.create({
      data: {
        id: versionId,
        organizationId,
        workflowId,
        version: 1,
        trigger: definition.trigger,
        conditions: definition.conditions as object[],
        actions: definition.actions as object[],
      },
    });
    await tx.workflow.update({ where: { id: workflowId }, data: { activeVersionId: versionId } });
  }
  return 2;
}

/** Removes only sample records (ORG-04). Real leads assigned to a sample rep go back to the pool. */
export async function deleteSampleData(tx: Tx) {
  const sampleMembers = await tx.organizationMembership.findMany({
    where: { isSample: true },
    select: { userId: true },
  });
  const userIds = sampleMembers.map((m) => m.userId);
  // Workflows first (their versions and run log go with them), then leads: the same order a
  // running sample workflow takes its locks in (its run, then the lead), so the two never deadlock.
  const { count: workflows } = await tx.workflow.deleteMany({ where: { isSample: true } });
  const { count: leads } = await tx.lead.deleteMany({ where: { isSample: true } });
  if (userIds.length) {
    // Tasks on real leads that were given to a sample rep lose their assignee when the rep goes,
    // so those leads need their next step recomputed below.
    const affected = await tx.task.findMany({
      where: { assigneeId: { in: userIds } },
      select: { leadId: true },
    });
    await tx.lead.updateMany({ where: { ownerId: { in: userIds } }, data: { ownerId: null } });
    await tx.organizationMembership.deleteMany({ where: { isSample: true } });
    await tx.user.deleteMany({
      where: { id: { in: userIds }, email: { endsWith: '@sample.datoflow.invalid' } },
    });
    const leadIds = [...new Set(affected.map((t) => t.leadId))];
    if (leadIds.length) {
      await refreshNextSteps(tx, { leadIds });
      await runRadar(tx, new Date(), { leadIds });
    }
  }
  return { leads, reps: userIds.length, workflows };
}
