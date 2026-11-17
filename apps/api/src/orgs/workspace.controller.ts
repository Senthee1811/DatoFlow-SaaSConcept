import { Controller, Delete, Get, Inject, Put, Req } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Db } from '@datoflow/db';
import { preferencesSchema, type AssigneeDto, type Preferences } from '@datoflow/shared';
import type { Request } from 'express';
import { actorFrom, audit } from '../audit/audit.js';
import { CurrentMembership, OrgRoute } from '../auth/guards.js';
import type { Membership } from '../http/request.js';
import { ZBody } from '../http/validation.js';
import { DB } from '../tokens.js';
import { retryOnConflict } from '../http/retry.js';
import { deleteSampleData } from './sample.js';

@ApiTags('Organizations')
@Controller('v1/orgs/:orgId')
export class WorkspaceController {
  constructor(@Inject(DB) private readonly db: Db) {}

  @Get('assignees')
  @OrgRoute()
  @ApiOperation({ summary: 'Members a lead can be assigned to, with names. Any member' })
  assignees(@CurrentMembership() membership: Membership): Promise<{ items: AssigneeDto[] }> {
    return this.db.withTenant(membership.organizationId, async (tx) => {
      const rows = await tx.organizationMembership.findMany({
        include: { user: { select: { name: true } } },
        orderBy: [{ isSample: 'asc' }, { createdAt: 'asc' }],
      });
      return {
        items: rows.map((m) => ({
          userId: m.userId,
          name: m.user.name,
          role: m.role,
          isSample: m.isSample,
        })),
      };
    });
  }

  @Get('me/preferences')
  @OrgRoute()
  @ApiOperation({ summary: 'Your saved filters and views in this workspace (LEAD-05)' })
  getPreferences(@CurrentMembership() membership: Membership): Promise<Preferences> {
    return this.db.withTenant(membership.organizationId, async (tx) => {
      const row = await tx.organizationMembership.findUniqueOrThrow({
        where: { id: membership.id },
      });
      return preferencesSchema.safeParse(row.preferences).data ?? {};
    });
  }

  @Put('me/preferences')
  @OrgRoute()
  @ApiOperation({
    summary:
      'Save your filters, views and reminder choices in this workspace. Sections left out stay as they are',
  })
  putPreferences(
    @CurrentMembership() membership: Membership,
    @ZBody(preferencesSchema) body: Preferences,
  ): Promise<Preferences> {
    return this.db.withTenant(membership.organizationId, async (tx) => {
      const row = await tx.organizationMembership.findUniqueOrThrow({
        where: { id: membership.id },
      });
      const merged = { ...(preferencesSchema.safeParse(row.preferences).data ?? {}), ...body };
      await tx.organizationMembership.update({
        where: { id: membership.id },
        data: { preferences: merged },
      });
      return merged;
    });
  }

  @Delete('sample-data')
  @OrgRoute('org.settings')
  @ApiOperation({ summary: 'Delete the sample agency. Real records stay untouched (ORG-04)' })
  deleteSample(@CurrentMembership() membership: Membership, @Req() req: Request) {
    // Sample workflows may be running on the sample leads at the same moment.
    return retryOnConflict(() =>
      this.db.withTenant(membership.organizationId, async (tx) => {
        const removed = await deleteSampleData(tx);
        await audit(tx, membership.organizationId, actorFrom(req), {
          action: 'sample.deleted',
          targetType: 'Organization',
          targetId: membership.organizationId,
          metadata: removed,
        });
        return removed;
      }),
    );
  }
}
