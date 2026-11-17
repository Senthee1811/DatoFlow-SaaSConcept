import { Controller, Get, HttpCode, Inject, Param, Post, Req } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { EmailAdapter } from '@datoflow/adapters';
import type { Db, Tx } from '@datoflow/db';
import {
  canGrantRole,
  checkSeats,
  invitationExpiry,
  invitationProblem,
  ROLE_LABEL,
  type InvitationProblem,
  type InvitationState,
  type Role,
} from '@datoflow/domain';
import {
  createInvitationSchema,
  ErrorCode,
  invitationTokenParam,
  pageQuerySchema,
  type CreateInvitationInput,
  type InvitationDto,
  type InvitationPreviewDto,
  type Page,
  type PageQuery,
  type ServerEnv,
} from '@datoflow/shared';
import { createHash, randomBytes } from 'node:crypto';
import type { Request } from 'express';
import type { Logger } from 'pino';
import { actorFrom, audit } from '../audit/audit.js';
import { CurrentMembership, CurrentUser, OptionalAuth, OrgRoute } from '../auth/guards.js';
import { ApiError } from '../http/errors.js';
import { pageArgs, toPage } from '../http/pagination.js';
import type { AuthUser, Membership } from '../http/request.js';
import { IdParam, ZBody, ZQuery } from '../http/validation.js';
import { DB, EMAIL, ENV, LOGGER } from '../tokens.js';

/** 32 random bytes, base64url. Only the SHA-256 hash is stored (ORG-03). */
export function newInvitationToken() {
  const token = randomBytes(32).toString('base64url');
  return { token, tokenHash: hashInvitationToken(token) };
}

export function hashInvitationToken(token: string) {
  return createHash('sha256').update(token).digest('hex');
}

type InvitationRow = {
  id: string;
  email: string;
  role: string;
  status: string;
  expiresAt: Date;
  inviterId: string;
  createdAt: Date;
};

function effectiveStatus(inv: InvitationRow, now = new Date()): InvitationState {
  if (inv.status === 'PENDING' && inv.expiresAt.getTime() <= now.getTime()) return 'EXPIRED';
  return inv.status as InvitationState;
}

function toInvitationDto(inv: InvitationRow): InvitationDto {
  return {
    id: inv.id,
    email: inv.email,
    role: inv.role as Role,
    status: effectiveStatus(inv),
    expiresAt: inv.expiresAt.toISOString(),
    invitedBy: inv.inviterId,
    createdAt: inv.createdAt.toISOString(),
  };
}

function parseToken(raw: string): string {
  // A malformed token is answered like an unknown one.
  const result = invitationTokenParam.safeParse(raw);
  if (!result.success) throw ApiError.notFound('Invitation');
  return result.data;
}

const PROBLEM_TEXT = {
  EXPIRED: 'This invitation has expired',
  USED: 'This invitation was already used',
  REVOKED: 'This invitation was withdrawn',
  EMAIL_MISMATCH: 'This invitation was sent to a different email address',
};

@ApiTags('Invitations')
@Controller('v1/orgs/:orgId/invitations')
export class OrgInvitationsController {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(EMAIL) private readonly email: EmailAdapter,
    @Inject(ENV) private readonly env: ServerEnv,
    @Inject(LOGGER) private readonly logger: Logger,
  ) {}

  @Get()
  @OrgRoute('members.manage')
  @ApiOperation({ summary: 'Invitations of the organization, newest first' })
  async list(
    @CurrentMembership() membership: Membership,
    @ZQuery(pageQuerySchema) query: PageQuery,
  ): Promise<Page<InvitationDto>> {
    const rows = await this.db.withTenant(membership.organizationId, (tx) =>
      tx.invitation.findMany({
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        ...pageArgs(query),
      }),
    );
    return toPage(rows, query, toInvitationDto);
  }

  @Post()
  @HttpCode(201)
  @OrgRoute('members.manage')
  @ApiOperation({ summary: 'Invite someone by email. 402 when the plan has no free seat (UF-4)' })
  async create(
    @CurrentMembership() actor: Membership,
    @CurrentUser() user: AuthUser,
    @ZBody(createInvitationSchema) body: CreateInvitationInput,
    @Req() req: Request,
  ): Promise<InvitationDto> {
    if (!canGrantRole(actor.role, body.role)) {
      throw ApiError.forbidden('Admins cannot invite an Owner');
    }
    const { token, tokenHash } = newInvitationToken();
    const { invitation, orgName } = await this.db.withTenant(actor.organizationId, async (tx) => {
      const org = await tx.organization.findUniqueOrThrow({ where: { id: actor.organizationId } });
      const existingMember = await tx.organizationMembership.findFirst({
        where: { user: { email: body.email } },
        select: { id: true },
      });
      if (existingMember) {
        throw new ApiError(409, ErrorCode.ALREADY_MEMBER, 'This person is already a member');
      }
      // One open invitation per address: a new one replaces the old.
      await tx.invitation.updateMany({
        where: { email: body.email, status: 'PENDING' },
        data: { status: 'REVOKED' },
      });
      await this.assertSeat(tx, org.planCode);

      const invitation = await tx.invitation.create({
        data: {
          organizationId: actor.organizationId,
          email: body.email,
          role: body.role,
          tokenHash,
          expiresAt: invitationExpiry(new Date()),
          inviterId: user.id,
        },
      });
      await audit(tx, actor.organizationId, actorFrom(req), {
        action: 'invitation.created',
        targetType: 'Invitation',
        targetId: invitation.id,
        metadata: { email: body.email, role: body.role },
      });
      return { invitation, orgName: org.name };
    });
    await this.sendInvite(body.email, body.role, orgName, user.name, token);
    return toInvitationDto(invitation);
  }

  @Post(':invitationId/resend')
  @OrgRoute('members.manage')
  @ApiOperation({ summary: 'Send the invitation again with a new link and a fresh 7-day expiry' })
  async resend(
    @CurrentMembership() actor: Membership,
    @CurrentUser() user: AuthUser,
    @IdParam('invitationId') invitationId: string,
    @Req() req: Request,
  ): Promise<InvitationDto> {
    const { token, tokenHash } = newInvitationToken();
    const { invitation, orgName } = await this.db.withTenant(actor.organizationId, async (tx) => {
      const current = await tx.invitation.findUnique({ where: { id: invitationId } });
      if (!current) throw ApiError.notFound('Invitation');
      if (!canGrantRole(actor.role, current.role as Role)) throw ApiError.forbidden();
      if (current.status !== 'PENDING') {
        throw new ApiError(
          409,
          ErrorCode.INVITATION_INVALID,
          'Only an open invitation can be sent again',
          {
            reason: current.status,
          },
        );
      }
      const org = await tx.organization.findUniqueOrThrow({ where: { id: actor.organizationId } });
      const invitation = await tx.invitation.update({
        where: { id: invitationId },
        data: { tokenHash, expiresAt: invitationExpiry(new Date()) },
      });
      await audit(tx, actor.organizationId, actorFrom(req), {
        action: 'invitation.resent',
        targetType: 'Invitation',
        targetId: invitationId,
        metadata: { email: current.email },
      });
      return { invitation, orgName: org.name };
    });
    await this.sendInvite(invitation.email, invitation.role as Role, orgName, user.name, token);
    return toInvitationDto(invitation);
  }

  @Post(':invitationId/revoke')
  @OrgRoute('members.manage')
  @ApiOperation({ summary: 'Withdraw an open invitation' })
  async revoke(
    @CurrentMembership() actor: Membership,
    @IdParam('invitationId') invitationId: string,
    @Req() req: Request,
  ): Promise<InvitationDto> {
    return this.db.withTenant(actor.organizationId, async (tx) => {
      const current = await tx.invitation.findUnique({ where: { id: invitationId } });
      if (!current) throw ApiError.notFound('Invitation');
      if (!canGrantRole(actor.role, current.role as Role)) throw ApiError.forbidden();
      if (current.status !== 'PENDING') return toInvitationDto(current);
      const invitation = await tx.invitation.update({
        where: { id: invitationId },
        data: { status: 'REVOKED' },
      });
      await audit(tx, actor.organizationId, actorFrom(req), {
        action: 'invitation.revoked',
        targetType: 'Invitation',
        targetId: invitationId,
        metadata: { email: current.email },
      });
      return toInvitationDto(invitation);
    });
  }

  /** Members plus open invitations must fit the plan's seat count (BILL-01 for users). */
  private async assertSeat(tx: Tx, planCode: string) {
    const now = new Date();
    const [members, pending] = await Promise.all([
      // Sample reps never take a seat.
      tx.organizationMembership.count({ where: { isSample: false } }),
      tx.invitation.count({ where: { status: 'PENDING', expiresAt: { gt: now } } }),
    ]);
    const seat = checkSeats(planCode, members, pending);
    if (!seat.ok) {
      throw new ApiError(
        402,
        ErrorCode.PLAN_LIMIT_REACHED,
        `Your plan includes ${seat.max} users. Upgrade to invite more people`,
        { limit: seat.limit },
      );
    }
  }

  private async sendInvite(
    to: string,
    role: Role,
    orgName: string,
    inviterName: string,
    token: string,
  ) {
    const link = `${this.env.APP_URL}/invite/${token}`;
    try {
      await this.email.send({
        to,
        subject: `${inviterName} invited you to ${orgName} on DatoFlow`,
        text: `${inviterName} invited you to join ${orgName} on DatoFlow as ${ROLE_LABEL[role]}.\n\nAccept the invitation here:\n${link}\n\nThe link works once and expires in 7 days.`,
      });
    } catch (err) {
      // The invitation exists; the admin can resend it. The token never goes to the log.
      this.logger.error({ err: (err as Error).message }, 'invitation email failed');
    }
  }
}

@ApiTags('Invitations')
@Controller('v1/invitations/:token')
export class InvitationTokenController {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(EMAIL) private readonly email: EmailAdapter,
    @Inject(LOGGER) private readonly logger: Logger,
  ) {}

  @Get()
  @OptionalAuth()
  @ApiOperation({ summary: 'What an invitation link is for, and whether it can be accepted' })
  async preview(@Param('token') raw: string, @Req() req: Request): Promise<InvitationPreviewDto> {
    const tokenHash = hashInvitationToken(parseToken(raw));
    const inv = await this.db.withSystem((tx) =>
      tx.invitation.findUnique({ where: { tokenHash }, include: { organization: true } }),
    );
    if (!inv || inv.organization.deletedAt) throw ApiError.notFound('Invitation');
    return {
      organizationName: inv.organization.name,
      organizationSlug: inv.organization.slug,
      email: inv.email,
      role: inv.role as Role,
      problem: invitationProblem(
        { ...inv, status: inv.status as InvitationState },
        req.user?.email ?? null,
        new Date(),
      ),
    };
  }

  @Post('accept')
  @ApiOperation({ summary: 'Accept an invitation as the signed-in invitee' })
  async accept(@Param('token') raw: string, @CurrentUser() user: AuthUser, @Req() req: Request) {
    const tokenHash = hashInvitationToken(parseToken(raw));
    const now = new Date();
    type Accepted = {
      inv: { id: string; organizationId: string; organization: { name: string; slug: string } };
      membership: { id: string; role: string };
      inviterEmail: string | null;
    };
    const result = await this.db.withSystem(
      async (tx): Promise<Accepted | { problem: InvitationProblem }> => {
        const inv = await tx.invitation.findUnique({
          where: { tokenHash },
          include: { organization: true },
        });
        if (!inv || inv.organization.deletedAt) throw ApiError.notFound('Invitation');
        const problem = invitationProblem(
          { ...inv, status: inv.status as InvitationState },
          user.email,
          now,
        );
        if (problem) {
          if (problem === 'EXPIRED' && inv.status === 'PENDING') {
            await tx.invitation.update({ where: { id: inv.id }, data: { status: 'EXPIRED' } });
          }
          return { problem };
        }
        // Single use, even under concurrent accepts: only one update can flip PENDING.
        const claimed = await tx.invitation.updateMany({
          where: { id: inv.id, status: 'PENDING' },
          data: { status: 'ACCEPTED', acceptedAt: now },
        });
        if (claimed.count !== 1) return { problem: 'USED' };

        const existing = await tx.organizationMembership.findUnique({
          where: { userId_organizationId: { userId: user.id, organizationId: inv.organizationId } },
        });
        const membership =
          existing ??
          (await tx.organizationMembership.create({
            data: { userId: user.id, organizationId: inv.organizationId, role: inv.role },
          }));
        await audit(tx, inv.organizationId, actorFrom(req), {
          action: 'invitation.accepted',
          targetType: 'Invitation',
          targetId: inv.id,
          metadata: { userId: user.id, role: membership.role, membershipId: membership.id },
        });
        const inviter = await tx.user.findUnique({
          where: { id: inv.inviterId },
          select: { email: true },
        });
        // The inviter hears about it in the notification centre (NOT-01), if still a member.
        const inviterIsMember = await tx.organizationMembership.findUnique({
          where: {
            userId_organizationId: { userId: inv.inviterId, organizationId: inv.organizationId },
          },
          select: { id: true },
        });
        if (inviterIsMember) {
          await tx.notification.create({
            data: {
              organizationId: inv.organizationId,
              userId: inv.inviterId,
              kind: 'MEMBER_JOINED',
              channel: 'IN_APP',
              payload: { userId: user.id, name: user.name, role: membership.role },
            },
          });
        }
        return { inv, membership, inviterEmail: inviter?.email ?? null };
      },
    );

    if (!('inv' in result)) {
      // The commit above keeps an EXPIRED status change. The UI shows "Ask for a new invite".
      const problem: InvitationProblem = result.problem;
      throw new ApiError(409, ErrorCode.INVITATION_INVALID, PROBLEM_TEXT[problem], {
        reason: problem,
      });
    }

    // The inviter is also told by email.
    if (result.inviterEmail) {
      await this.email
        .send({
          to: result.inviterEmail,
          subject: `${user.name} joined ${result.inv.organization.name}`,
          text: `${user.name} (${user.email}) accepted your invitation and joined ${result.inv.organization.name} as ${ROLE_LABEL[result.membership.role as Role]}.`,
        })
        .catch((err: unknown) =>
          this.logger.error({ err: (err as Error).message }, 'inviter email failed'),
        );
    }

    return {
      organizationId: result.inv.organizationId,
      organizationSlug: result.inv.organization.slug,
      role: result.membership.role as Role,
    };
  }
}
