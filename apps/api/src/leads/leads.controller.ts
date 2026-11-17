import { Controller, Get, HttpCode, Inject, Patch, Post } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Db, Prisma } from '@datoflow/db';
import { can, endOfDayInZone, startOfDayInZone } from '@datoflow/domain';
import {
  createActivitySchema,
  createLeadSchema,
  idParam,
  leadListQuerySchema,
  pageQuerySchema,
  updateLeadSchema,
  type ActivityDto,
  type CreateActivityInput,
  type CreateLeadInput,
  type LeadDto,
  type LeadListQuery,
  type LeadSummaryDto,
  type Page,
  type PageQuery,
  type TouchResultDto,
  type UpdateLeadInput,
} from '@datoflow/shared';
import { CurrentMembership, CurrentUser, OrgRoute } from '../auth/guards.js';
import { ApiError } from '../http/errors.js';
import { pageArgs, toPage } from '../http/pagination.js';
import type { AuthUser, Membership } from '../http/request.js';
import { IdParam, ZBody, ZQuery } from '../http/validation.js';
import { logTouch } from '../tasks/task-service.js';
import { DB } from '../tokens.js';
import {
  addNote,
  createLead,
  editableLead,
  loadOrgContext,
  memberOf,
  setArchived,
  toActivityDto,
  toLeadDto,
  toLeadSummary,
  updateLead,
  visibleLead,
  type Member,
  type OrgContext,
} from './lead-service.js';

type Where = Prisma.LeadWhereInput;

/** Turns LEAD-05 filters into a Prisma filter, always inside the member's scope. */
export function leadWhere(query: LeadListQuery, member: Member, org: OrgContext, now: Date): Where {
  const and: Where[] = [];
  if (member.scope.kind === 'own_and_pool') {
    and.push({ OR: [{ ownerId: member.scope.userId }, { ownerId: null }] });
  }
  and.push({ archivedAt: query.archived ? { not: null } : null });
  if (query.sample === 'exclude') and.push({ isSample: false });
  if (query.sample === 'only') and.push({ isSample: true });
  if (query.q) {
    const q = query.q;
    const digits = q.replace(/\D/g, '');
    and.push({
      OR: [
        { name: { contains: q, mode: 'insensitive' } },
        { company: { contains: q, mode: 'insensitive' } },
        { emailNormalized: { contains: q.toLowerCase() } },
        ...(digits.length >= 4 ? [{ phoneE164: { contains: digits } }] : []),
      ],
    });
  }
  if (query.owner?.length) {
    const ids = query.owner.filter((o) => o !== 'me' && o !== 'none');
    if (query.owner.includes('me')) ids.push(member.userId);
    and.push({
      OR: [
        ...(ids.length ? [{ ownerId: { in: ids } }] : []),
        ...(query.owner.includes('none') ? [{ ownerId: null }] : []),
      ],
    });
  }
  if (query.stage?.length) and.push({ stageId: { in: query.stage } });
  if (query.source?.length) and.push({ source: { in: query.source } });
  if (query.priority?.length) and.push({ priority: { in: query.priority } });
  if (query.createdFrom)
    and.push({ createdAt: { gte: startOfDayInZone(query.createdFrom, org.timezone) } });
  if (query.createdTo)
    and.push({ createdAt: { lt: endOfDayInZone(query.createdTo, org.timezone) } });
  if (query.status === 'open') and.push({ stage: { kind: 'OPEN' } });
  if (query.status === 'won') and.push({ stage: { kind: 'WON' } });
  if (query.status === 'lost') and.push({ stage: { kind: 'LOST' } });
  // Stuck: no activity past the stage SLA, or an overdue next step (TASK-03). Both deadlines are
  // null on closed leads, and archived leads are filtered above.
  if (query.stuck === true)
    and.push({ OR: [{ slaDueAt: { lt: now } }, { nextStepDueAt: { lt: now } }] });
  if (query.stuck === false) {
    and.push({ OR: [{ slaDueAt: null }, { slaDueAt: { gte: now } }] });
    and.push({ OR: [{ nextStepDueAt: null }, { nextStepDueAt: { gte: now } }] });
  }
  return { AND: and };
}

const ORDER: Record<LeadListQuery['sort'], Prisma.LeadOrderByWithRelationInput[]> = {
  created_desc: [{ createdAt: 'desc' }, { id: 'desc' }],
  created_asc: [{ createdAt: 'asc' }, { id: 'asc' }],
  updated_desc: [{ updatedAt: 'desc' }, { id: 'desc' }],
  sla_asc: [{ slaDueAt: { sort: 'asc', nulls: 'last' } }, { id: 'asc' }],
  value_desc: [{ dealValue: { sort: 'desc', nulls: 'last' } }, { id: 'desc' }],
  name_asc: [{ name: 'asc' }, { id: 'asc' }],
};

@ApiTags('Leads')
@Controller('v1/orgs/:orgId/leads')
export class LeadsController {
  constructor(@Inject(DB) private readonly db: Db) {}

  private ctx<T>(
    membership: Membership,
    user: AuthUser,
    fn: (
      tx: Parameters<Parameters<Db['withTenant']>[1]>[0],
      org: OrgContext,
      member: Member,
    ) => Promise<T>,
  ) {
    return this.db.withTenant(membership.organizationId, async (tx) => {
      const org = await loadOrgContext(tx, membership.organizationId);
      return fn(tx, org, memberOf(user, membership.role, org));
    });
  }

  @Get()
  @OrgRoute('leads.view')
  @ApiOperation({
    summary: 'Search and filter leads (LEAD-05). Sales Reps see their leads and the pool',
  })
  list(
    @CurrentMembership() membership: Membership,
    @CurrentUser() user: AuthUser,
    @ZQuery(leadListQuerySchema) query: LeadListQuery,
  ): Promise<Page<LeadSummaryDto>> {
    if (query.cursor && !idParam.safeParse(query.cursor).success)
      throw ApiError.validation([{ path: 'query.cursor', message: 'Invalid cursor' }]);
    if (query.archived && !can(membership.role, 'leads.archive')) {
      throw ApiError.forbidden('Only Owners, Admins and Sales Managers can list archived leads');
    }
    return this.ctx(membership, user, async (tx, org, member) => {
      const now = new Date();
      const rows = await tx.lead.findMany({
        where: leadWhere(query, member, org, now),
        include: {
          owner: { select: { name: true } },
          stage: { select: { kind: true, slaHours: true } },
        },
        orderBy: ORDER[query.sort],
        ...pageArgs({ limit: query.limit, cursor: query.cursor }),
      });
      return toPage(rows, { limit: query.limit, cursor: query.cursor }, (l) =>
        toLeadSummary(l, now),
      );
    });
  }

  @Post()
  @HttpCode(201)
  @OrgRoute('leads.view')
  @ApiOperation({ summary: 'Create a lead (LEAD-01). Email and phone are normalised (LEAD-02)' })
  create(
    @CurrentMembership() membership: Membership,
    @CurrentUser() user: AuthUser,
    @ZBody(createLeadSchema) body: CreateLeadInput,
  ): Promise<LeadDto> {
    return this.ctx(membership, user, async (tx, org, member) => {
      const lead = await createLead(tx, org, member, body);
      return toLeadDto(tx, member, lead);
    });
  }

  @Get(':leadId')
  @OrgRoute('leads.view')
  @ApiOperation({ summary: 'One lead, with possible duplicates (LEAD-03)' })
  get(
    @CurrentMembership() membership: Membership,
    @CurrentUser() user: AuthUser,
    @IdParam('leadId') leadId: string,
  ): Promise<LeadDto> {
    return this.ctx(membership, user, async (tx, _org, member) =>
      toLeadDto(tx, member, await visibleLead(tx, member, leadId)),
    );
  }

  @Patch(':leadId')
  @OrgRoute('leads.view')
  @ApiOperation({ summary: 'Edit a lead, move its stage or reassign it (PIPE-03 rules apply)' })
  update(
    @CurrentMembership() membership: Membership,
    @CurrentUser() user: AuthUser,
    @IdParam('leadId') leadId: string,
    @ZBody(updateLeadSchema) body: UpdateLeadInput,
  ): Promise<LeadDto> {
    return this.ctx(membership, user, async (tx, org, member) => {
      const lead = await editableLead(tx, member, leadId);
      if (lead.archivedAt)
        throw new ApiError(409, 'CONFLICT', 'Restore the lead before changing it');
      return toLeadDto(tx, member, await updateLead(tx, org, member, lead, body));
    });
  }

  @Post(':leadId/archive')
  @OrgRoute('leads.archive')
  @ApiOperation({ summary: 'Archive a lead. Owner, Admin and Sales Manager' })
  archive(
    @CurrentMembership() membership: Membership,
    @CurrentUser() user: AuthUser,
    @IdParam('leadId') leadId: string,
  ) {
    return this.ctx(membership, user, async (tx, org, member) =>
      toLeadDto(
        tx,
        member,
        await setArchived(tx, org, member, await visibleLead(tx, member, leadId), true),
      ),
    );
  }

  @Post(':leadId/restore')
  @OrgRoute('leads.archive')
  @ApiOperation({ summary: 'Restore an archived lead. Owner, Admin and Sales Manager' })
  restore(
    @CurrentMembership() membership: Membership,
    @CurrentUser() user: AuthUser,
    @IdParam('leadId') leadId: string,
  ) {
    return this.ctx(membership, user, async (tx, org, member) =>
      toLeadDto(
        tx,
        member,
        await setArchived(tx, org, member, await visibleLead(tx, member, leadId), false),
      ),
    );
  }

  @Get(':leadId/activities')
  @OrgRoute('leads.view')
  @ApiOperation({ summary: 'The lead timeline, newest first (LEAD-06)' })
  activities(
    @CurrentMembership() membership: Membership,
    @CurrentUser() user: AuthUser,
    @IdParam('leadId') leadId: string,
    @ZQuery(pageQuerySchema) query: PageQuery,
  ): Promise<Page<ActivityDto>> {
    return this.ctx(membership, user, async (tx, _org, member) => {
      await visibleLead(tx, member, leadId);
      const rows = await tx.leadActivity.findMany({
        where: { leadId },
        orderBy: [{ occurredAt: 'desc' }, { id: 'desc' }],
        ...pageArgs(query),
      });
      return toPage(rows, query, toActivityDto);
    });
  }

  @Post(':leadId/activities')
  @HttpCode(201)
  @OrgRoute('leads.view')
  @ApiOperation({
    summary:
      'Add a note, or log a touch (call, email, WhatsApp, meeting). A touch on an open lead needs a ' +
      'new next step unless it closes the lead as Won or Lost: 422 NEXT_STEP_REQUIRED (TASK-02)',
  })
  addActivity(
    @CurrentMembership() membership: Membership,
    @CurrentUser() user: AuthUser,
    @IdParam('leadId') leadId: string,
    @ZBody(createActivitySchema) body: CreateActivityInput,
  ): Promise<ActivityDto | TouchResultDto> {
    return this.ctx(membership, user, async (tx, org, member) => {
      const lead = await editableLead(tx, member, leadId);
      if (body.type === 'TOUCH') return logTouch(tx, org, member, lead, body);
      await addNote(tx, org, member, lead, body.text);
      const latest = await tx.leadActivity.findFirstOrThrow({
        where: { leadId, type: 'NOTE' },
        orderBy: { occurredAt: 'desc' },
      });
      return toActivityDto(latest);
    });
  }
}
