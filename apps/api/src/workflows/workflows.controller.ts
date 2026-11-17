import { Controller, Get, HttpCode, Inject, Post, Req } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Db, Prisma } from '@datoflow/db';
import {
  createVersionSchema,
  createWorkflowSchema,
  ErrorCode,
  emptyQuerySchema,
  executionListQuerySchema,
  workflowListQuerySchema,
  type CreateVersionInput,
  type CreateWorkflowInput,
  type ExecutionDetailDto,
  type ExecutionDto,
  type ExecutionListQuery,
  type Page,
  type WorkflowDto,
  type WorkflowListQuery,
  type WorkflowSummaryDto,
} from '@datoflow/shared';
import type { Request } from 'express';
import { actorFrom, audit } from '../audit/audit.js';
import { CurrentMembership, CurrentUser, OrgRoute } from '../auth/guards.js';
import { ApiError } from '../http/errors.js';
import { pageArgs, toPage } from '../http/pagination.js';
import type { AuthUser, Membership } from '../http/request.js';
import { IdParam, ZBody, ZQuery } from '../http/validation.js';
import { DB } from '../tokens.js';
import { RunQueue } from './run-queue.js';
import {
  activate,
  assertDefinition,
  EXECUTION_INCLUDE,
  findWorkflow,
  leadNames,
  pause,
  retryExecution,
  saveVersion,
  summarise,
  toExecutionDetail,
  toExecutionDto,
  toWorkflowDto,
} from './workflow-service.js';

/** Workflows (WF-01, WF-05, WF-06). Sales Managers and up; Sales Reps have no access. */
@ApiTags('Workflows')
@Controller('v1/orgs/:orgId')
export class WorkflowsController {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(RunQueue) private readonly runs: RunQueue,
  ) {}

  @Get('workflows')
  @OrgRoute('workflows.manage')
  @ApiOperation({ summary: 'Workflows, newest first, with their runs over the last 30 days' })
  list(
    @CurrentMembership() membership: Membership,
    @ZQuery(workflowListQuerySchema) query: WorkflowListQuery,
  ): Promise<Page<WorkflowSummaryDto>> {
    return this.db.withTenant(membership.organizationId, async (tx) => {
      const rows = await tx.workflow.findMany({
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        ...pageArgs(query),
      });
      const summaries = await summarise(tx, rows.slice(0, query.limit));
      return toPage(rows, query, (w) => summaries.get(w.id)!);
    });
  }

  @Post('workflows')
  @HttpCode(201)
  @OrgRoute('workflows.manage')
  @ApiOperation({
    summary:
      'Create a workflow as a draft with its first version (WF-01): one trigger, AND-ed conditions, 1 to 10 actions',
  })
  create(
    @Req() req: Request,
    @CurrentMembership() membership: Membership,
    @CurrentUser() user: AuthUser,
    @ZBody(createWorkflowSchema) body: CreateWorkflowInput,
  ): Promise<WorkflowDto> {
    return this.db.withTenant(membership.organizationId, async (tx) => {
      const def = await assertDefinition(tx, body.definition);
      const workflow = await tx.workflow.create({
        data: {
          organizationId: membership.organizationId,
          name: body.name,
          status: 'DRAFT',
          createdById: user.id,
        },
      });
      const saved = await saveVersion(tx, workflow, def, user.id);
      await audit(tx, membership.organizationId, actorFrom(req), {
        action: 'workflow.created',
        targetType: 'Workflow',
        targetId: workflow.id,
        metadata: { name: body.name, trigger: def.trigger, version: 1 },
      });
      return toWorkflowDto(tx, saved);
    });
  }

  @Get('workflows/:workflowId')
  @OrgRoute('workflows.manage')
  @ApiOperation({ summary: 'A workflow with its latest definition and its versions' })
  get(
    @CurrentMembership() membership: Membership,
    @IdParam('workflowId') workflowId: string,
    @ZQuery(emptyQuerySchema) _query: Record<string, never>,
  ): Promise<WorkflowDto> {
    return this.db.withTenant(membership.organizationId, async (tx) =>
      toWorkflowDto(tx, await findWorkflow(tx, workflowId)),
    );
  }

  @Post('workflows/:workflowId/versions')
  @HttpCode(201)
  @OrgRoute('workflows.manage')
  @ApiOperation({
    summary:
      'Save a new immutable version (WF-01). An active workflow runs it from now on; runs already queued keep theirs',
  })
  saveVersion(
    @Req() req: Request,
    @CurrentMembership() membership: Membership,
    @CurrentUser() user: AuthUser,
    @IdParam('workflowId') workflowId: string,
    @ZBody(createVersionSchema) body: CreateVersionInput,
  ): Promise<WorkflowDto> {
    return this.db.withTenant(membership.organizationId, async (tx) => {
      const workflow = await findWorkflow(tx, workflowId);
      const def = await assertDefinition(tx, body.definition);
      const saved = await saveVersion(tx, workflow, def, user.id, body.name);
      await audit(tx, membership.organizationId, actorFrom(req), {
        action: 'workflow.version_saved',
        targetType: 'Workflow',
        targetId: workflow.id,
        metadata: { version: saved.latestVersion, trigger: def.trigger },
      });
      return toWorkflowDto(tx, saved);
    });
  }

  @Post('workflows/:workflowId/activate')
  @HttpCode(200)
  @OrgRoute('workflows.manage')
  @ApiOperation({
    summary:
      "Activate or resume a workflow with its latest version (WF-05). 402 over the plan's active-workflow limit",
  })
  activate(
    @Req() req: Request,
    @CurrentMembership() membership: Membership,
    @IdParam('workflowId') workflowId: string,
  ): Promise<WorkflowDto> {
    return this.db.withTenant(membership.organizationId, async (tx) => {
      const workflow = await findWorkflow(tx, workflowId);
      const org = await tx.organization.findUniqueOrThrow({
        where: { id: membership.organizationId },
        select: { planCode: true },
      });
      const updated = await activate(tx, workflow, org.planCode);
      await audit(tx, membership.organizationId, actorFrom(req), {
        action: workflow.status === 'PAUSED' ? 'workflow.resumed' : 'workflow.activated',
        targetType: 'Workflow',
        targetId: workflow.id,
        metadata: { version: updated.latestVersion },
      });
      return toWorkflowDto(tx, updated);
    });
  }

  @Post('workflows/:workflowId/pause')
  @HttpCode(200)
  @OrgRoute('workflows.manage')
  @ApiOperation({ summary: 'Pause a workflow. Its queued runs become CANCELLED (WF-05)' })
  pause(
    @Req() req: Request,
    @CurrentMembership() membership: Membership,
    @IdParam('workflowId') workflowId: string,
  ): Promise<WorkflowDto> {
    return this.db.withTenant(membership.organizationId, async (tx) => {
      const workflow = await findWorkflow(tx, workflowId);
      if (workflow.status !== 'ACTIVE') {
        throw new ApiError(409, ErrorCode.CONFLICT, 'Only an active workflow can be paused');
      }
      const result = await pause(tx, workflow);
      await audit(tx, membership.organizationId, actorFrom(req), {
        action: 'workflow.paused',
        targetType: 'Workflow',
        targetId: workflow.id,
        metadata: { cancelledRuns: result.cancelled },
      });
      return toWorkflowDto(tx, result.workflow);
    });
  }

  @Get('executions')
  @OrgRoute('workflows.manage')
  @ApiOperation({
    summary: 'The execution log (WF-06), newest first. Filter by workflow, lead or status',
  })
  executions(
    @CurrentMembership() membership: Membership,
    @ZQuery(executionListQuerySchema) query: ExecutionListQuery,
  ): Promise<Page<ExecutionDto>> {
    return this.db.withTenant(membership.organizationId, async (tx) => {
      const where: Prisma.WorkflowExecutionWhereInput = {
        ...(query.workflowId ? { workflowId: query.workflowId } : {}),
        ...(query.leadId ? { leadId: query.leadId } : {}),
        ...(query.status ? { status: query.status } : {}),
      };
      const rows = await tx.workflowExecution.findMany({
        where,
        include: EXECUTION_INCLUDE,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        ...pageArgs(query),
      });
      const names = await leadNames(tx, rows);
      return toPage(rows, query, (e) => toExecutionDto(e, names));
    });
  }

  @Get('executions/:executionId')
  @OrgRoute('workflows.manage')
  @ApiOperation({ summary: 'One run with its step results, attempts and error details (WF-06)' })
  execution(
    @CurrentMembership() membership: Membership,
    @IdParam('executionId') executionId: string,
    @ZQuery(emptyQuerySchema) _query: Record<string, never>,
  ): Promise<ExecutionDetailDto> {
    return this.db.withTenant(membership.organizationId, async (tx) => {
      const e = await tx.workflowExecution.findUnique({
        where: { id: executionId },
        include: EXECUTION_INCLUDE,
      });
      if (!e) throw ApiError.notFound('Run');
      return toExecutionDetail(tx, e);
    });
  }

  @Post('executions/:executionId/retry')
  @HttpCode(200)
  @OrgRoute('workflows.manage')
  @ApiOperation({ summary: 'Retry a FAILED or DEAD run (WF-06). Any other status is a 409' })
  async retry(
    @Req() req: Request,
    @CurrentMembership() membership: Membership,
    @IdParam('executionId') executionId: string,
  ): Promise<ExecutionDetailDto> {
    const detail = await this.db.withTenant(membership.organizationId, async (tx) => {
      const e = await tx.workflowExecution.findUnique({
        where: { id: executionId },
        include: EXECUTION_INCLUDE,
      });
      if (!e) throw ApiError.notFound('Run');
      const queued = await retryExecution(tx, e);
      await audit(tx, membership.organizationId, actorFrom(req), {
        action: 'workflow.run_retried',
        targetType: 'WorkflowExecution',
        targetId: e.id,
        metadata: { workflowId: e.workflowId, from: e.status },
      });
      return toExecutionDetail(tx, queued);
    });
    // Queued after the commit, so the worker never sees the run before it is QUEUED.
    await this.runs.enqueueRun(detail.id, detail.manualRetries);
    return detail;
  }
}
