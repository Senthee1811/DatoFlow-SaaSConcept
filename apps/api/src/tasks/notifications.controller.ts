import { Controller, Get, HttpCode, Inject, Post } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Db } from '@datoflow/db';
import {
  emptyQuerySchema,
  notificationListQuerySchema,
  type NotificationDto,
  type NotificationKind,
  type NotificationListQuery,
  type Page,
} from '@datoflow/shared';
import { CurrentMembership, OrgRoute } from '../auth/guards.js';
import { ApiError } from '../http/errors.js';
import { pageArgs, toPage } from '../http/pagination.js';
import type { Membership } from '../http/request.js';
import { IdParam, ZQuery } from '../http/validation.js';
import { DB } from '../tokens.js';

/** The notification centre (NOT-01): your in-app notifications in this workspace. */
@ApiTags('Notifications')
@Controller('v1/orgs/:orgId/notifications')
export class NotificationsController {
  constructor(@Inject(DB) private readonly db: Db) {}

  private mine(membership: Membership) {
    return { userId: membership.userId, channel: 'IN_APP' as const };
  }

  @Get()
  @OrgRoute()
  @ApiOperation({ summary: 'Your notifications, newest first (NOT-01)' })
  list(
    @CurrentMembership() membership: Membership,
    @ZQuery(notificationListQuerySchema) query: NotificationListQuery,
  ): Promise<Page<NotificationDto>> {
    return this.db.withTenant(membership.organizationId, async (tx) => {
      const rows = await tx.notification.findMany({
        where: { ...this.mine(membership), ...(query.unread ? { readAt: null } : {}) },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        ...pageArgs(query),
      });
      return toPage(rows, query, (n) => ({
        id: n.id,
        kind: n.kind as NotificationKind,
        payload: (n.payload ?? {}) as Record<string, unknown>,
        readAt: n.readAt?.toISOString() ?? null,
        createdAt: n.createdAt.toISOString(),
      }));
    });
  }

  @Get('unread-count')
  @OrgRoute()
  @ApiOperation({
    summary: 'How many of your notifications are unread. The web polls it every 30 s',
  })
  unreadCount(
    @CurrentMembership() membership: Membership,
    @ZQuery(emptyQuerySchema) _query: Record<string, never>,
  ): Promise<{ unread: number }> {
    return this.db.withTenant(membership.organizationId, async (tx) => ({
      unread: await tx.notification.count({ where: { ...this.mine(membership), readAt: null } }),
    }));
  }

  @Post(':notificationId/read')
  @HttpCode(200)
  @OrgRoute()
  @ApiOperation({ summary: 'Mark one notification as read' })
  read(
    @CurrentMembership() membership: Membership,
    @IdParam('notificationId') id: string,
  ): Promise<{ unread: number }> {
    return this.db.withTenant(membership.organizationId, async (tx) => {
      const found = await tx.notification.findFirst({ where: { id, ...this.mine(membership) } });
      if (!found) throw ApiError.notFound('Notification');
      if (!found.readAt)
        await tx.notification.update({ where: { id }, data: { readAt: new Date() } });
      return {
        unread: await tx.notification.count({ where: { ...this.mine(membership), readAt: null } }),
      };
    });
  }

  @Post('read-all')
  @HttpCode(200)
  @OrgRoute()
  @ApiOperation({ summary: 'Mark all your notifications as read' })
  readAll(@CurrentMembership() membership: Membership): Promise<{ unread: number }> {
    return this.db.withTenant(membership.organizationId, async (tx) => {
      await tx.notification.updateMany({
        where: { ...this.mine(membership), readAt: null },
        data: { readAt: new Date() },
      });
      return { unread: 0 };
    });
  }
}
