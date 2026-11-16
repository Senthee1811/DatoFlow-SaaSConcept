import { Controller, Get, Inject } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Db } from '@datoflow/db';
import { pageQuerySchema, type AuditLogDto, type Page, type PageQuery } from '@datoflow/shared';
import { CurrentMembership, OrgRoute } from '../auth/guards.js';
import { pageArgs, toPage } from '../http/pagination.js';
import type { Membership } from '../http/request.js';
import { ZQuery } from '../http/validation.js';
import { DB } from '../tokens.js';

@ApiTags('Audit')
@Controller('v1/orgs/:orgId/audit-logs')
export class AuditController {
  constructor(@Inject(DB) private readonly db: Db) {}

  @Get()
  @OrgRoute('audit.view')
  @ApiOperation({ summary: 'Audit log, newest first. Owner and Admin' })
  async list(
    @CurrentMembership() membership: Membership,
    @ZQuery(pageQuerySchema) query: PageQuery,
  ): Promise<Page<AuditLogDto>> {
    const rows = await this.db.withTenant(membership.organizationId, async (tx) => {
      const logs = await tx.auditLog.findMany({
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        ...pageArgs(query),
      });
      // Actor names come from memberships of this organization only.
      const members = await tx.organizationMembership.findMany({
        where: {
          userId: { in: [...new Set(logs.map((l) => l.actorId).filter((x): x is string => !!x))] },
        },
        select: { userId: true, user: { select: { name: true } } },
      });
      const names = new Map(members.map((m) => [m.userId, m.user.name]));
      return logs.map((l) => ({
        ...l,
        actorName: l.actorId ? (names.get(l.actorId) ?? null) : null,
      }));
    });
    return toPage(rows, query, (l) => ({
      id: l.id,
      action: l.action,
      actorId: l.actorId,
      actorName: l.actorName,
      targetType: l.targetType,
      targetId: l.targetId,
      metadata: (l.metadata ?? {}) as Record<string, unknown>,
      ip: l.ip,
      createdAt: l.createdAt.toISOString(),
    }));
  }
}
