import { Controller, Get, Inject, Patch, Put, Req } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Db, Tx } from '@datoflow/db';
import { planStages, type StageKind } from '@datoflow/domain';
import {
  ErrorCode,
  lossReasonsSchema,
  updatePipelineSchema,
  updateStagesSchema,
  type LossReasonDto,
  type LossReasonsInput,
  type PipelineDto,
  type UpdateStagesInput,
} from '@datoflow/shared';
import type { Request } from 'express';
import { actorFrom, audit } from '../audit/audit.js';
import { CurrentMembership, OrgRoute } from '../auth/guards.js';
import { ApiError } from '../http/errors.js';
import type { Membership } from '../http/request.js';
import { IdParam, ZBody } from '../http/validation.js';
import { DB } from '../tokens.js';

async function pipelineDto(tx: Tx, pipelineId: string): Promise<PipelineDto> {
  const pipeline = await tx.pipeline.findUnique({
    where: { id: pipelineId },
    include: { stages: { orderBy: { order: 'asc' } } },
  });
  if (!pipeline) throw ApiError.notFound('Pipeline');
  const counts = await tx.lead.groupBy({
    by: ['stageId'],
    where: { pipelineId },
    _count: { _all: true },
  });
  const byStage = new Map(counts.map((c) => [c.stageId, c._count._all]));
  return {
    id: pipeline.id,
    name: pipeline.name,
    stages: pipeline.stages.map((s) => ({
      id: s.id,
      name: s.name,
      order: s.order,
      slaHours: s.slaHours,
      kind: s.kind,
      leadCount: byStage.get(s.id) ?? 0,
    })),
  };
}

@ApiTags('Pipelines')
@Controller('v1/orgs/:orgId/pipelines')
export class PipelinesController {
  constructor(@Inject(DB) private readonly db: Db) {}

  @Get()
  @OrgRoute()
  @ApiOperation({ summary: 'Pipelines with their stages in board order. Any member' })
  list(@CurrentMembership() membership: Membership): Promise<{ items: PipelineDto[] }> {
    return this.db.withTenant(membership.organizationId, async (tx) => {
      const pipelines = await tx.pipeline.findMany({
        orderBy: { createdAt: 'asc' },
        select: { id: true },
      });
      return { items: await Promise.all(pipelines.map((p) => pipelineDto(tx, p.id))) };
    });
  }

  @Patch(':pipelineId')
  @OrgRoute('org.settings')
  @ApiOperation({ summary: 'Rename a pipeline. Owner and Admin' })
  rename(
    @CurrentMembership() membership: Membership,
    @IdParam('pipelineId') pipelineId: string,
    @ZBody(updatePipelineSchema) body: { name: string },
    @Req() req: Request,
  ): Promise<PipelineDto> {
    return this.db.withTenant(membership.organizationId, async (tx) => {
      const found = await tx.pipeline.findUnique({ where: { id: pipelineId } });
      if (!found) throw ApiError.notFound('Pipeline');
      await tx.pipeline.update({ where: { id: pipelineId }, data: { name: body.name } });
      await audit(tx, membership.organizationId, actorFrom(req), {
        action: 'pipeline.updated',
        targetType: 'Pipeline',
        targetId: pipelineId,
        metadata: { name: body.name },
      });
      return pipelineDto(tx, pipelineId);
    });
  }

  @Patch(':pipelineId/stages')
  @OrgRoute('org.settings')
  @ApiOperation({
    summary:
      'Replace the stage list: add, rename, reorder, set SLA hours, mark Won or Lost (PIPE-01)',
    description:
      'A stage that holds leads cannot be removed, or switch between open and closed, until its leads are moved.',
  })
  stages(
    @CurrentMembership() membership: Membership,
    @IdParam('pipelineId') pipelineId: string,
    @ZBody(updateStagesSchema) body: UpdateStagesInput,
    @Req() req: Request,
  ): Promise<PipelineDto> {
    return this.db.withTenant(membership.organizationId, async (tx) => {
      const before = await pipelineDto(tx, pipelineId);
      const plan = planStages(
        before.stages.map((s) => ({ id: s.id, kind: s.kind as StageKind, leadCount: s.leadCount })),
        body.stages,
      );
      if (!plan.ok && plan.code === 'INVALID_STAGES') {
        throw new ApiError(422, ErrorCode.INVALID_STAGES, 'The stage list is not valid', {
          errors: plan.errors,
        });
      }
      if (!plan.ok) {
        throw new ApiError(
          409,
          ErrorCode.STAGE_NOT_EMPTY,
          'Move the leads out of these stages first',
          {
            ids: plan.stageIds,
          },
        );
      }

      await tx.pipelineStage.deleteMany({ where: { id: { in: plan.removed } } });
      // Shift every order out of the way first, so the unique (pipelineId, order) never collides.
      await tx.pipelineStage.updateMany({
        where: { pipelineId },
        data: { order: { increment: 1000 } },
      });
      const slaChanged: { id: string; slaHours: number }[] = [];
      for (const [order, stage] of body.stages.entries()) {
        if (stage.id) {
          const old = before.stages.find((s) => s.id === stage.id)!;
          if (old.slaHours !== stage.slaHours)
            slaChanged.push({ id: stage.id, slaHours: stage.slaHours });
          await tx.pipelineStage.update({
            where: { id: stage.id },
            data: { name: stage.name, slaHours: stage.slaHours, kind: stage.kind, order },
          });
        } else {
          await tx.pipelineStage.create({
            data: {
              organizationId: membership.organizationId,
              pipelineId,
              name: stage.name,
              slaHours: stage.slaHours,
              kind: stage.kind,
              order,
            },
          });
        }
      }
      // A new SLA applies to the leads already in the stage.
      for (const s of slaChanged) {
        await tx.$executeRaw`
          UPDATE "Lead" SET "slaDueAt" = "lastActivityAt" + make_interval(hours => ${s.slaHours}::int)
          WHERE "stageId" = ${s.id} AND "organizationId" = ${membership.organizationId}`;
      }
      const after = await pipelineDto(tx, pipelineId);
      await audit(tx, membership.organizationId, actorFrom(req), {
        action: 'pipeline.updated',
        targetType: 'Pipeline',
        targetId: pipelineId,
        metadata: {
          stages: after.stages.map((s) => ({ name: s.name, kind: s.kind, slaHours: s.slaHours })),
        },
      });
      return after;
    });
  }
}

@ApiTags('Pipelines')
@Controller('v1/orgs/:orgId/loss-reasons')
export class LossReasonsController {
  constructor(@Inject(DB) private readonly db: Db) {}

  @Get()
  @OrgRoute()
  @ApiOperation({ summary: 'Loss reasons, in order. Any member' })
  list(@CurrentMembership() membership: Membership): Promise<{ items: LossReasonDto[] }> {
    return this.db.withTenant(membership.organizationId, async (tx) => ({
      items: (await tx.lossReason.findMany({ orderBy: [{ order: 'asc' }, { label: 'asc' }] })).map(
        (r) => ({
          id: r.id,
          label: r.label,
          active: r.active,
        }),
      ),
    }));
  }

  @Put()
  @OrgRoute('org.settings')
  @ApiOperation({
    summary: 'Replace the loss reasons. Reasons in use are deactivated, not deleted',
  })
  replace(
    @CurrentMembership() membership: Membership,
    @ZBody(lossReasonsSchema) body: LossReasonsInput,
    @Req() req: Request,
  ): Promise<{ items: LossReasonDto[] }> {
    const labels = body.reasons.map((r) => r.label.toLowerCase());
    if (new Set(labels).size !== labels.length) {
      throw ApiError.validation([
        { path: 'body.reasons', message: 'Loss reasons must be different' },
      ]);
    }
    return this.db.withTenant(membership.organizationId, async (tx) => {
      const current = await tx.lossReason.findMany();
      const known = new Set(current.map((r) => r.id));
      const unknown = body.reasons.find((r) => r.id && !known.has(r.id));
      if (unknown)
        throw ApiError.validation([{ path: 'body.reasons', message: 'Unknown loss reason' }]);
      const kept = new Set(body.reasons.map((r) => r.id).filter(Boolean));
      for (const old of current.filter((r) => !kept.has(r.id))) {
        const used = await tx.lead.count({ where: { lossReasonId: old.id } });
        if (used > 0)
          await tx.lossReason.update({
            where: { id: old.id },
            data: { active: false, label: `${old.label} (retired ${old.id.slice(0, 4)})` },
          });
        else await tx.lossReason.delete({ where: { id: old.id } });
      }
      // Temporary labels avoid clashes with the unique (organizationId, label) while renaming.
      for (const r of body.reasons.filter((x) => x.id)) {
        await tx.lossReason.update({ where: { id: r.id! }, data: { label: `__${r.id}` } });
      }
      for (const [order, r] of body.reasons.entries()) {
        if (r.id)
          await tx.lossReason.update({
            where: { id: r.id },
            data: { label: r.label, active: r.active, order },
          });
        else
          await tx.lossReason.create({
            data: {
              organizationId: membership.organizationId,
              label: r.label,
              active: r.active,
              order,
            },
          });
      }
      await audit(tx, membership.organizationId, actorFrom(req), {
        action: 'loss_reasons.updated',
        targetType: 'Organization',
        targetId: membership.organizationId,
        metadata: { labels: body.reasons.map((r) => r.label) },
      });
      const items = await tx.lossReason.findMany({
        where: { label: { not: { startsWith: '__' } } },
        orderBy: [{ order: 'asc' }],
      });
      return { items: items.map((r) => ({ id: r.id, label: r.label, active: r.active })) };
    });
  }
}
