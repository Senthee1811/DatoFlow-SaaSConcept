import { refreshLeads, type Db, type Tx } from '@datoflow/db';
import {
  actorName,
  canEditLead,
  canSeeLead,
  cleanText,
  decideStageMove,
  diffFields,
  duplicateReason,
  leadScope,
  nameCompanyKey,
  normaliseContact,
  slaDueAt,
  stuckReasons,
  type ActivityType,
  type ActorType,
  type DuplicateKeys,
  type LeadScope,
  type Role,
  type StageKind,
} from '@datoflow/domain';
import {
  ErrorCode,
  orgSettingsSchema,
  type ActivityDto,
  type CreateLeadInput,
  type LeadDto,
  type LeadSummaryDto,
  type OrgSettings,
  type UpdateLeadInput,
} from '@datoflow/shared';
import { ApiError } from '../http/errors.js';

/** Who made a change. Workflow changes carry the workflow's name (LEAD-06). */
export interface Actor {
  type: ActorType;
  id: string | null;
  label: string | null;
}

export interface OrgContext {
  id: string;
  currency: string;
  country: string;
  timezone: string;
  settings: OrgSettings;
}

export async function loadOrgContext(tx: Tx, organizationId: string): Promise<OrgContext> {
  const org = await tx.organization.findUniqueOrThrow({ where: { id: organizationId } });
  return {
    id: org.id,
    currency: org.currency,
    country: org.country,
    timezone: org.timezone,
    settings: orgSettingsSchema.safeParse(org.settings).data ?? {},
  };
}

/** The caller as a member: role, scope of visible leads, and the actor for the timeline. */
export interface Member {
  userId: string;
  name: string;
  role: Role;
  scope: LeadScope;
  actor: Actor;
}

export function memberOf(user: { id: string; name: string }, role: Role, org: OrgContext): Member {
  return {
    userId: user.id,
    name: user.name,
    role,
    scope: leadScope(role, user.id, org.settings),
    actor: { type: 'USER', id: user.id, label: user.name },
  };
}

/** Runs `fn` in a tenant transaction with the organization and the caller as a member. */
export function withMember<T>(
  db: Db,
  membership: { organizationId: string; role: Role },
  user: { id: string; name: string },
  fn: (tx: Tx, org: OrgContext, member: Member) => Promise<T>,
): Promise<T> {
  return db.withTenant(membership.organizationId, async (tx) => {
    const org = await loadOrgContext(tx, membership.organizationId);
    return fn(tx, org, memberOf(user, membership.role, org));
  });
}

const LEAD_INCLUDE = {
  owner: { select: { name: true } },
  stage: { select: { kind: true, slaHours: true } },
} as const;

export type LeadRow = NonNullable<Awaited<ReturnType<typeof findLead>>>;

async function findLead(tx: Tx, id: string) {
  return tx.lead.findUnique({ where: { id }, include: LEAD_INCLUDE });
}

/**
 * Recomputes the lead's next step and runs the stuck-lead radar on it (TASK-03), then reads it
 * back. Every change to a lead or its tasks ends here.
 */
export async function refreshLead(tx: Tx, id: string, now = new Date()): Promise<LeadRow> {
  await refreshLeads(tx, [id], now);
  return (await findLead(tx, id))!;
}

/** A lead the member can see, or 404. A lead outside a Rep's scope looks like one that does not exist. */
export async function visibleLead(tx: Tx, member: Member, id: string): Promise<LeadRow> {
  const lead = await findLead(tx, id);
  if (!lead || !canSeeLead(member.scope, lead)) throw ApiError.notFound('Lead');
  return lead;
}

/** A lead the member can edit: visible (else 404) and within their edit scope (else 403). */
export async function editableLead(tx: Tx, member: Member, id: string): Promise<LeadRow> {
  const lead = await visibleLead(tx, member, id);
  if (!canEditLead(member.role, member.userId, lead)) {
    throw ApiError.forbidden('Sales Reps can edit only leads assigned to them');
  }
  return lead;
}

export function toLeadSummary(lead: LeadRow, now = new Date()): LeadSummaryDto {
  const reasons = stuckReasons(
    {
      kind: lead.stage.kind,
      archivedAt: lead.archivedAt,
      slaDueAt: lead.slaDueAt,
      nextStepDueAt: lead.nextStepDueAt,
    },
    now,
  );
  return {
    id: lead.id,
    name: lead.name,
    company: lead.company,
    email: lead.email,
    phone: lead.phone,
    source: lead.source,
    stageId: lead.stageId,
    ownerId: lead.ownerId,
    ownerName: lead.owner?.name ?? null,
    priority: lead.priority,
    dealValue: lead.dealValue === null ? null : Number(lead.dealValue),
    currency: lead.currency,
    isSample: lead.isSample,
    stuck: reasons.length > 0,
    stuckReasons: reasons,
    stuckAt: lead.stuckAt?.toISOString() ?? null,
    slaDueAt: lead.slaDueAt?.toISOString() ?? null,
    nextStepDueAt: lead.nextStepDueAt?.toISOString() ?? null,
    lastActivityAt: lead.lastActivityAt.toISOString(),
    archivedAt: lead.archivedAt?.toISOString() ?? null,
    createdAt: lead.createdAt.toISOString(),
    updatedAt: lead.updatedAt.toISOString(),
  };
}

export async function toLeadDto(tx: Tx, member: Member, lead: LeadRow): Promise<LeadDto> {
  const pairs = await tx.leadDuplicate.findMany({
    where: { OR: [{ leadId: lead.id }, { candidateId: lead.id }], status: 'OPEN' },
    include: {
      lead: { select: { id: true, name: true, company: true, ownerId: true } },
      candidate: { select: { id: true, name: true, company: true, ownerId: true } },
    },
  });
  const duplicates = pairs
    .map((p) => ({ other: p.leadId === lead.id ? p.candidate : p.lead, reason: p.reason }))
    // Only duplicates the member can open are linked.
    .filter((d) => canSeeLead(member.scope, d.other))
    .map((d) => ({
      leadId: d.other.id,
      name: d.other.name,
      company: d.other.company,
      reason: d.reason,
    }));
  return {
    ...toLeadSummary(lead),
    emailNormalized: lead.emailNormalized,
    phoneE164: lead.phoneE164,
    notes: lead.notes,
    utm: (lead.utm as Record<string, string> | null) ?? null,
    lossReasonId: lead.lossReasonId,
    stageEnteredAt: lead.stageEnteredAt.toISOString(),
    closedAt: lead.closedAt?.toISOString() ?? null,
    duplicates,
    tags: lead.tags ?? [],
    canEdit: canEditLead(member.role, member.userId, lead),
  };
}

export function toActivityDto(a: {
  id: string;
  type: string;
  actorType: ActorType;
  actorId: string | null;
  actorLabel: string | null;
  payload: unknown;
  occurredAt: Date;
}): ActivityDto {
  return {
    id: a.id,
    type: a.type,
    actor: {
      type: a.actorType,
      id: a.actorId,
      name: actorName({ type: a.actorType, label: a.actorLabel }),
    },
    payload: (a.payload ?? {}) as Record<string, unknown>,
    occurredAt: a.occurredAt.toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

export async function activity(
  tx: Tx,
  organizationId: string,
  leadId: string,
  actor: Actor,
  type: ActivityType,
  payload: Record<string, unknown> = {},
  occurredAt = new Date(),
) {
  await tx.leadActivity.create({
    data: {
      organizationId,
      leadId,
      type,
      actorType: actor.type,
      actorId: actor.id,
      actorLabel: actor.label,
      payload: payload as object,
      occurredAt,
    },
  });
}

/** Written in the same transaction as the change, so automation never misses or invents one. */
async function outbox(
  tx: Tx,
  organizationId: string,
  type: 'lead.created' | 'lead.stage_changed' | 'lead.assigned',
  leadId: string,
  payload: Record<string, unknown>,
) {
  await tx.outboxEvent.create({
    data: {
      organizationId,
      type,
      aggregateType: 'Lead',
      aggregateId: leadId,
      payload: payload as object,
    },
  });
}

async function resolveStage(tx: Tx, stageId: string | undefined) {
  if (stageId) {
    const stage = await tx.pipelineStage.findUnique({ where: { id: stageId } });
    if (!stage)
      throw ApiError.validation([
        { path: 'body.stageId', message: 'Choose a stage from this pipeline' },
      ]);
    return stage;
  }
  const first = await tx.pipelineStage.findFirst({
    where: { kind: 'OPEN', pipeline: { isDefault: true } },
    orderBy: { order: 'asc' },
  });
  if (!first) throw new Error('The organization has no open stage');
  return first;
}

async function assertAssignable(tx: Tx, ownerId: string | null | undefined) {
  if (!ownerId) return;
  const membership = await tx.organizationMembership.findFirst({
    where: { userId: ownerId },
    select: { id: true },
  });
  if (!membership) {
    throw ApiError.validation([
      { path: 'body.ownerId', message: 'Choose a member of this workspace' },
    ]);
  }
}

async function assertLossReason(tx: Tx, lossReasonId: string | null | undefined) {
  if (!lossReasonId) return;
  const reason = await tx.lossReason.findUnique({ where: { id: lossReasonId } });
  if (!reason || !reason.active) {
    throw ApiError.validation([
      { path: 'body.lossReasonId', message: 'Choose one of the loss reasons' },
    ]);
  }
}

function assertStageMove(
  org: OrgContext,
  kind: StageKind,
  lossReasonId: string | null,
  dealValue: number | null,
) {
  const move = decideStageMove({
    toKind: kind,
    lossReasonId,
    dealValue,
    wonRequiresDealValue: org.settings.wonRequiresDealValue ?? true,
  });
  if (!move.ok) {
    throw new ApiError(422, ErrorCode[move.code], move.message, {
      errors: [{ path: move.path, message: move.message }],
    });
  }
}

/** Records possible duplicates of `lead` (LEAD-03). Sample and real leads are never paired. Never merges. */
async function detectDuplicates(
  tx: Tx,
  organizationId: string,
  lead: DuplicateKeys & { id: string; isSample: boolean },
  actor: Actor,
) {
  const or = [
    lead.emailNormalized ? { emailNormalized: lead.emailNormalized } : null,
    lead.phoneE164 ? { phoneE164: lead.phoneE164 } : null,
    lead.nameCompanyKey ? { nameCompanyKey: lead.nameCompanyKey } : null,
  ].filter((x): x is NonNullable<typeof x> => x !== null);
  if (or.length === 0) return;
  const candidates = await tx.lead.findMany({
    where: { id: { not: lead.id }, isSample: lead.isSample, OR: or },
    select: { id: true, name: true, emailNormalized: true, phoneE164: true, nameCompanyKey: true },
    orderBy: { createdAt: 'asc' },
    take: 20,
  });
  if (candidates.length === 0) return;
  const existing = await tx.leadDuplicate.findMany({
    where: { OR: [{ leadId: lead.id }, { candidateId: lead.id }] },
    select: { leadId: true, candidateId: true },
  });
  const known = new Set(existing.map((p) => (p.leadId === lead.id ? p.candidateId : p.leadId)));
  for (const candidate of candidates) {
    const reason = duplicateReason(lead, candidate);
    if (!reason || known.has(candidate.id)) continue;
    await tx.leadDuplicate.create({
      data: { organizationId, leadId: lead.id, candidateId: candidate.id, reason },
    });
    await activity(tx, organizationId, lead.id, actor, 'DUPLICATE_FOUND', {
      candidateId: candidate.id,
      candidateName: candidate.name,
      reason,
    });
  }
}

export async function createLead(
  tx: Tx,
  org: OrgContext,
  member: Member,
  input: CreateLeadInput,
): Promise<LeadRow> {
  const contact = normaliseContact(
    { email: input.email ?? null, phone: input.phone ?? null },
    org.country,
  );
  if (!contact.ok) throw ApiError.validation(contact.errors);

  // A Sales Rep cannot assign leads to others. Leads they add are theirs unless they choose the pool.
  const ownerId = input.ownerId === undefined ? member.userId : input.ownerId;
  if (member.role === 'REP' && ownerId !== null && ownerId !== member.userId) {
    throw ApiError.forbidden('Sales Reps cannot assign leads to others');
  }
  await assertAssignable(tx, ownerId);
  const stage = await resolveStage(tx, input.stageId);
  const dealValue = input.dealValue ?? null;
  const lossReasonId = stage.kind === 'LOST' ? (input.lossReasonId ?? null) : null;
  assertStageMove(org, stage.kind, lossReasonId, dealValue);
  await assertLossReason(tx, lossReasonId);

  const now = new Date();
  const name = cleanText(input.name)!;
  const company = cleanText(input.company);
  const lead = await tx.lead.create({
    data: {
      organizationId: org.id,
      pipelineId: stage.pipelineId,
      stageId: stage.id,
      ownerId,
      name,
      company,
      email: cleanText(input.email),
      emailNormalized: contact.value.emailNormalized ?? null,
      phone: cleanText(input.phone),
      phoneE164: contact.value.phoneE164 ?? null,
      nameCompanyKey: nameCompanyKey(name, company),
      source: input.source,
      priority: input.priority,
      dealValue,
      currency: org.currency,
      notes: input.notes?.trim() || null,
      utm: input.utm ?? undefined,
      lossReasonId,
      createdById: member.actor.type === 'USER' ? member.actor.id : null,
      stageEnteredAt: now,
      lastActivityAt: now,
      slaDueAt: slaDueAt(now, stage.slaHours, stage.kind),
      closedAt: stage.kind === 'OPEN' ? null : now,
    },
    include: LEAD_INCLUDE,
  });
  await tx.stageHistory.create({
    data: {
      organizationId: org.id,
      leadId: lead.id,
      toStageId: stage.id,
      actorId: member.actor.id,
      enteredAt: now,
    },
  });
  await activity(tx, org.id, lead.id, member.actor, 'CREATED', {
    source: lead.source,
    stageId: stage.id,
    ownerId,
  });
  await detectDuplicates(tx, org.id, lead, member.actor);
  await outbox(tx, org.id, 'lead.created', lead.id, {
    leadId: lead.id,
    stageId: stage.id,
    ownerId,
    source: lead.source,
    priority: lead.priority,
    isSample: false,
  });
  return refreshLead(tx, lead.id, now);
}

export async function updateLead(
  tx: Tx,
  org: OrgContext,
  member: Member,
  lead: LeadRow,
  input: UpdateLeadInput,
): Promise<LeadRow> {
  const contact = normaliseContact({ email: input.email, phone: input.phone }, org.country);
  if (!contact.ok) throw ApiError.validation(contact.errors);

  const ownerChanged = input.ownerId !== undefined && input.ownerId !== lead.ownerId;
  if (ownerChanged) {
    if (member.role === 'REP') throw ApiError.forbidden('Sales Reps cannot reassign leads');
    await assertAssignable(tx, input.ownerId);
  }

  const stageChanged = input.stageId !== undefined && input.stageId !== lead.stageId;
  const stage = stageChanged ? await resolveStage(tx, input.stageId) : null;
  const kind: StageKind = stage?.kind ?? lead.stage.kind;
  const slaHours = stage?.slaHours ?? lead.stage.slaHours;
  const dealValue =
    input.dealValue !== undefined
      ? input.dealValue
      : lead.dealValue === null
        ? null
        : Number(lead.dealValue);
  const lossReasonId =
    kind === 'LOST'
      ? input.lossReasonId !== undefined
        ? input.lossReasonId
        : lead.lossReasonId
      : null;
  if (stageChanged || input.dealValue !== undefined || input.lossReasonId !== undefined) {
    assertStageMove(org, kind, lossReasonId, dealValue);
  }
  if (lossReasonId !== lead.lossReasonId) await assertLossReason(tx, lossReasonId);

  const name = input.name !== undefined ? cleanText(input.name)! : lead.name;
  const company = input.company !== undefined ? cleanText(input.company) : lead.company;
  const fields = {
    ...(input.name !== undefined ? { name } : {}),
    ...(input.company !== undefined ? { company } : {}),
    ...(input.email !== undefined
      ? { email: cleanText(input.email), emailNormalized: contact.value.emailNormalized ?? null }
      : {}),
    ...(input.phone !== undefined
      ? { phone: cleanText(input.phone), phoneE164: contact.value.phoneE164 ?? null }
      : {}),
    ...(input.source !== undefined ? { source: input.source } : {}),
    ...(input.priority !== undefined ? { priority: input.priority } : {}),
    ...(input.dealValue !== undefined ? { dealValue: input.dealValue } : {}),
    ...(input.notes !== undefined ? { notes: input.notes?.trim() || null } : {}),
    ...(input.utm !== undefined ? { utm: input.utm ?? undefined } : {}),
  };
  const changes = diffFields(
    {
      name: lead.name,
      company: lead.company,
      email: lead.email,
      phone: lead.phone,
      source: lead.source,
      priority: lead.priority,
      dealValue: lead.dealValue === null ? null : Number(lead.dealValue),
      notes: lead.notes,
      utm: lead.utm,
    },
    {
      ...fields,
      ...(input.dealValue !== undefined ? { dealValue: input.dealValue } : {}),
    },
  );

  const now = new Date();
  // A stage change or a reassignment counts as follow-up activity and restarts the SLA clock.
  const lastActivityAt = stageChanged || ownerChanged ? now : lead.lastActivityAt;
  const updated = await tx.lead.update({
    where: { id: lead.id },
    data: {
      ...fields,
      ...(input.name !== undefined || input.company !== undefined
        ? { nameCompanyKey: nameCompanyKey(name, company) }
        : {}),
      ...(ownerChanged ? { ownerId: input.ownerId ?? null } : {}),
      ...(stage
        ? {
            stageId: stage.id,
            pipelineId: stage.pipelineId,
            stageEnteredAt: now,
            closedAt: kind === 'OPEN' ? null : now,
          }
        : {}),
      lossReasonId,
      lastActivityAt,
      slaDueAt: slaDueAt(lastActivityAt, slaHours, kind),
    },
    include: LEAD_INCLUDE,
  });

  if (changes.length) await activity(tx, org.id, lead.id, member.actor, 'UPDATED', { changes });
  if (stage) {
    await tx.stageHistory.create({
      data: {
        organizationId: org.id,
        leadId: lead.id,
        fromStageId: lead.stageId,
        toStageId: stage.id,
        actorId: member.actor.id,
        enteredAt: now,
      },
    });
    await activity(tx, org.id, lead.id, member.actor, 'STAGE_CHANGED', {
      fromStageId: lead.stageId,
      toStageId: stage.id,
      ...(lossReasonId ? { lossReasonId } : {}),
    });
    await outbox(tx, org.id, 'lead.stage_changed', lead.id, {
      leadId: lead.id,
      fromStageId: lead.stageId,
      toStageId: stage.id,
      toKind: kind,
      ownerId: updated.ownerId,
      isSample: lead.isSample,
    });
  }
  if (ownerChanged) {
    await activity(tx, org.id, lead.id, member.actor, 'ASSIGNED', {
      fromOwnerId: lead.ownerId,
      toOwnerId: updated.ownerId,
    });
    await outbox(tx, org.id, 'lead.assigned', lead.id, {
      leadId: lead.id,
      fromOwnerId: lead.ownerId,
      toOwnerId: updated.ownerId,
      isSample: lead.isSample,
    });
  }
  if (['name', 'company', 'email', 'phone'].some((f) => f in fields)) {
    await detectDuplicates(tx, org.id, updated, member.actor);
  }
  return refreshLead(tx, lead.id, now);
}

export async function setArchived(
  tx: Tx,
  org: OrgContext,
  member: Member,
  lead: LeadRow,
  archived: boolean,
) {
  if ((lead.archivedAt !== null) === archived) return lead;
  const updated = await tx.lead.update({
    where: { id: lead.id },
    data: { archivedAt: archived ? new Date() : null },
    include: LEAD_INCLUDE,
  });
  await activity(tx, org.id, lead.id, member.actor, archived ? 'ARCHIVED' : 'RESTORED');
  return refreshLead(tx, updated.id);
}

export async function addNote(
  tx: Tx,
  org: OrgContext,
  member: Member,
  lead: LeadRow,
  text: string,
) {
  const now = new Date();
  await activity(tx, org.id, lead.id, member.actor, 'NOTE', { text }, now);
  await tx.lead.update({
    where: { id: lead.id },
    data: { lastActivityAt: now, slaDueAt: slaDueAt(now, lead.stage.slaHours, lead.stage.kind) },
  });
  await refreshLead(tx, lead.id, now);
}
