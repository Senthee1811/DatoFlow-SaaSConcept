import { Controller, Get, HttpCode, Inject, Patch, Post, Req } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Db } from '@datoflow/db';
import { DEFAULT_LOSS_REASONS, DEFAULT_PIPELINE, type Role } from '@datoflow/domain';
import {
  createOrgSchema,
  ErrorCode,
  orgSettingsSchema,
  updateOrgSchema,
  type CreateOrgInput,
  type OrgDto,
  type UpdateOrgInput,
} from '@datoflow/shared';
import type { Request } from 'express';
import { actorFrom, audit } from '../audit/audit.js';
import { CurrentMembership, CurrentUser, OrgRoute } from '../auth/guards.js';
import { ApiError } from '../http/errors.js';
import type { AuthUser, Membership } from '../http/request.js';
import { ZBody } from '../http/validation.js';
import { DB } from '../tokens.js';
import { seedSampleWorkspace } from './sample.js';

interface OrgRow {
  id: string;
  name: string;
  slug: string;
  timezone: string;
  currency: string;
  country: string;
  planCode: string;
  settings: unknown;
  createdAt: Date;
}

export function toOrgDto(org: OrgRow, role: Role, hasSampleData = false): OrgDto {
  const settings = orgSettingsSchema.safeParse(org.settings);
  return {
    id: org.id,
    name: org.name,
    slug: org.slug,
    timezone: org.timezone,
    currency: org.currency,
    country: org.country,
    planCode: org.planCode,
    settings: settings.success ? settings.data : {},
    hasSampleData,
    role,
    createdAt: org.createdAt.toISOString(),
  };
}

@ApiTags('Organizations')
@Controller('v1/orgs')
export class OrgsController {
  constructor(@Inject(DB) private readonly db: Db) {}

  @Get()
  @ApiOperation({ summary: 'Organizations the signed-in user belongs to' })
  async list(@CurrentUser() user: AuthUser): Promise<{ items: OrgDto[] }> {
    const memberships = await this.db.withSystem((tx) =>
      tx.organizationMembership.findMany({
        where: { userId: user.id, organization: { deletedAt: null } },
        include: { organization: true },
        orderBy: { organization: { name: 'asc' } },
      }),
    );
    const ids = memberships.map((m) => m.organizationId);
    const withSample = await this.db.withSystem((tx) =>
      tx.organizationMembership.groupBy({
        by: ['organizationId'],
        where: { organizationId: { in: ids }, isSample: true },
      }),
    );
    const sample = new Set(withSample.map((r) => r.organizationId));
    return {
      items: memberships.map((m) =>
        toOrgDto(m.organization, m.role as Role, sample.has(m.organizationId)),
      ),
    };
  }

  @Post()
  @HttpCode(201)
  @ApiOperation({ summary: 'Create an organization. The creator becomes its Owner (ORG-01)' })
  async create(
    @CurrentUser() user: AuthUser,
    @ZBody(createOrgSchema) body: CreateOrgInput,
    @Req() req: Request,
  ): Promise<OrgDto> {
    if (!user.emailVerified) {
      throw new ApiError(
        403,
        ErrorCode.EMAIL_NOT_VERIFIED,
        'Confirm your email before creating an organization',
      );
    }
    const actor = actorFrom(req);
    return this.db.withSystem(async (tx) => {
      const taken = await tx.organization.findUnique({
        where: { slug: body.slug },
        select: { id: true },
      });
      if (taken) {
        throw new ApiError(409, ErrorCode.SLUG_TAKEN, 'This address is taken', {
          errors: [{ path: 'body.slug', message: 'This address is taken' }],
        });
      }
      const { withSampleData, ...fields } = body;
      const org = await tx.organization.create({ data: { ...fields, settings: {} } });
      await tx.organizationMembership.create({
        data: { organizationId: org.id, userId: user.id, role: 'OWNER' },
      });
      const pipeline = await tx.pipeline.create({
        data: { organizationId: org.id, name: DEFAULT_PIPELINE.name, isDefault: true },
      });
      await tx.pipelineStage.createMany({
        data: DEFAULT_PIPELINE.stages.map((s) => ({
          ...s,
          organizationId: org.id,
          pipelineId: pipeline.id,
        })),
      });
      await tx.lossReason.createMany({
        data: DEFAULT_LOSS_REASONS.map((label, order) => ({
          organizationId: org.id,
          label,
          order,
        })),
      });
      const sample = withSampleData ? await seedSampleWorkspace(tx, org) : null;
      await audit(tx, org.id, actor, {
        action: 'org.created',
        targetType: 'Organization',
        targetId: org.id,
        metadata: { name: org.name, slug: org.slug, sampleData: Boolean(sample) },
      });
      return toOrgDto(org, 'OWNER', Boolean(sample));
    });
  }

  @Get(':orgId')
  @OrgRoute()
  @ApiOperation({ summary: 'One organization. 404 without membership (ORG-02)' })
  async get(@CurrentMembership() membership: Membership): Promise<OrgDto> {
    return this.db.withTenant(membership.organizationId, async (tx) => {
      const org = await tx.organization.findUniqueOrThrow({
        where: { id: membership.organizationId },
      });
      const sample = await tx.organizationMembership.count({ where: { isSample: true } });
      return toOrgDto(org, membership.role, sample > 0);
    });
  }

  @Patch(':orgId')
  @OrgRoute('org.settings')
  @ApiOperation({ summary: 'Update name, timezone, currency or settings. Owner and Admin' })
  async update(
    @CurrentMembership() membership: Membership,
    @ZBody(updateOrgSchema) body: UpdateOrgInput,
    @Req() req: Request,
  ): Promise<OrgDto> {
    return this.db.withTenant(membership.organizationId, async (tx) => {
      const current = await tx.organization.findUniqueOrThrow({
        where: { id: membership.organizationId },
      });
      const settings = body.settings
        ? { ...(orgSettingsSchema.safeParse(current.settings).data ?? {}), ...body.settings }
        : undefined;
      const org = await tx.organization.update({
        where: { id: membership.organizationId },
        data: { ...body, ...(settings ? { settings } : {}) },
      });
      await audit(tx, org.id, actorFrom(req), {
        action: 'org.updated',
        targetType: 'Organization',
        targetId: org.id,
        metadata: { fields: Object.keys(body) },
      });
      const sample = await tx.organizationMembership.count({ where: { isSample: true } });
      return toOrgDto(org, membership.role, sample > 0);
    });
  }
}
