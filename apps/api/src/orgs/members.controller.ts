import { Controller, Delete, Get, HttpCode, Inject, Patch, Req } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Db, Tx } from '@datoflow/db';
import { decideMemberChange, type Role } from '@datoflow/domain';
import {
  ErrorCode,
  pageQuerySchema,
  updateMemberSchema,
  type MemberDto,
  type Page,
  type PageQuery,
  type UpdateMemberInput,
} from '@datoflow/shared';
import type { Request } from 'express';
import { actorFrom, audit } from '../audit/audit.js';
import { CurrentMembership, OrgRoute } from '../auth/guards.js';
import { ApiError } from '../http/errors.js';
import { pageArgs, toPage } from '../http/pagination.js';
import type { Membership } from '../http/request.js';
import { IdParam, ZBody, ZQuery } from '../http/validation.js';
import { DB } from '../tokens.js';

type MemberRow = {
  id: string;
  userId: string;
  role: string;
  createdAt: Date;
  user: { name: string; email: string };
};

function toMemberDto(m: MemberRow): MemberDto {
  return {
    id: m.id,
    userId: m.userId,
    name: m.user.name,
    email: m.user.email,
    role: m.role as Role,
    joinedAt: m.createdAt.toISOString(),
  };
}

/** Locks the organization's Owner rows so two concurrent demotions cannot remove the last Owner. */
async function lockOwners(tx: Tx, organizationId: string): Promise<number> {
  const rows = await tx.$queryRaw<{ id: string }[]>`
    SELECT id FROM "OrganizationMembership"
    WHERE "organizationId" = ${organizationId} AND role = 'OWNER'
    FOR UPDATE`;
  return rows.length;
}

@ApiTags('Members')
@Controller('v1/orgs/:orgId/members')
export class MembersController {
  constructor(@Inject(DB) private readonly db: Db) {}

  @Get()
  @OrgRoute('members.manage')
  @ApiOperation({ summary: 'Members of the organization. Owner and Admin' })
  async list(
    @CurrentMembership() membership: Membership,
    @ZQuery(pageQuerySchema) query: PageQuery,
  ): Promise<Page<MemberDto>> {
    const rows = await this.db.withTenant(membership.organizationId, (tx) =>
      tx.organizationMembership.findMany({
        include: { user: { select: { name: true, email: true } } },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        ...pageArgs(query),
      }),
    );
    return toPage(rows, query, toMemberDto);
  }

  @Patch(':memberId')
  @OrgRoute('members.manage')
  @ApiOperation({
    summary: 'Change a member role. Admins cannot touch Owners; the last Owner stays',
  })
  async update(
    @CurrentMembership() actor: Membership,
    @IdParam('memberId') memberId: string,
    @ZBody(updateMemberSchema) body: UpdateMemberInput,
    @Req() req: Request,
  ): Promise<MemberDto> {
    return this.db.withTenant(actor.organizationId, async (tx) => {
      const ownerCount = await lockOwners(tx, actor.organizationId);
      const target = await tx.organizationMembership.findUnique({
        where: { id: memberId },
        include: { user: { select: { name: true, email: true } } },
      });
      if (!target) throw ApiError.notFound('Member');
      this.assertAllowed(actor.role, target.role as Role, body.role, ownerCount);
      if (target.role === body.role) return toMemberDto(target);

      const updated = await tx.organizationMembership.update({
        where: { id: memberId },
        data: { role: body.role },
        include: { user: { select: { name: true, email: true } } },
      });
      await audit(tx, actor.organizationId, actorFrom(req), {
        action: 'member.role_changed',
        targetType: 'OrganizationMembership',
        targetId: memberId,
        metadata: { userId: target.userId, from: target.role, to: body.role },
      });
      return toMemberDto(updated);
    });
  }

  @Delete(':memberId')
  @HttpCode(204)
  @OrgRoute('members.manage')
  @ApiOperation({ summary: 'Remove a member. Admins cannot remove Owners; the last Owner stays' })
  async remove(
    @CurrentMembership() actor: Membership,
    @IdParam('memberId') memberId: string,
    @Req() req: Request,
  ): Promise<void> {
    await this.db.withTenant(actor.organizationId, async (tx) => {
      const ownerCount = await lockOwners(tx, actor.organizationId);
      const target = await tx.organizationMembership.findUnique({ where: { id: memberId } });
      if (!target) throw ApiError.notFound('Member');
      this.assertAllowed(actor.role, target.role as Role, null, ownerCount);

      await tx.organizationMembership.delete({ where: { id: memberId } });
      // The removed person's sessions stop pointing at this workspace.
      await tx.session.updateMany({
        where: { userId: target.userId, activeOrganizationId: actor.organizationId },
        data: { activeOrganizationId: null },
      });
      await audit(tx, actor.organizationId, actorFrom(req), {
        action: 'member.removed',
        targetType: 'OrganizationMembership',
        targetId: memberId,
        metadata: { userId: target.userId, role: target.role },
      });
    });
  }

  private assertAllowed(actor: Role, current: Role, next: Role | null, ownerCount: number) {
    const decision = decideMemberChange({
      actorRole: actor,
      currentRole: current,
      nextRole: next,
      ownerCount,
    });
    if (decision.ok) return;
    if (decision.reason === 'LAST_OWNER') {
      throw new ApiError(
        409,
        ErrorCode.LAST_OWNER,
        'Make someone else an Owner first. The last Owner cannot be removed or demoted',
      );
    }
    throw ApiError.forbidden('Admins cannot grant, change or remove the Owner role');
  }
}
