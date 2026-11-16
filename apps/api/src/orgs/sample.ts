import type { Tx } from '@datoflow/db';
import {
  buildSampleWorkspace,
  duplicateReason,
  nameCompanyKey,
  normaliseLeadEmail,
  normalisePhone,
  sampleDealValue,
  slaDueAt,
} from '@datoflow/domain';
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
  return { leads: leads.length, reps: repIds.length };
}

/** Removes only sample records (ORG-04). Real leads assigned to a sample rep go back to the pool. */
export async function deleteSampleData(tx: Tx) {
  const sampleMembers = await tx.organizationMembership.findMany({
    where: { isSample: true },
    select: { userId: true },
  });
  const userIds = sampleMembers.map((m) => m.userId);
  const { count: leads } = await tx.lead.deleteMany({ where: { isSample: true } });
  if (userIds.length) {
    await tx.lead.updateMany({ where: { ownerId: { in: userIds } }, data: { ownerId: null } });
    await tx.organizationMembership.deleteMany({ where: { isSample: true } });
    await tx.user.deleteMany({
      where: { id: { in: userIds }, email: { endsWith: '@sample.datoflow.invalid' } },
    });
  }
  return { leads, reps: userIds.length };
}
