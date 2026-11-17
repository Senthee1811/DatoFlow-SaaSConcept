import { Controller, Get, HttpCode, Inject, Patch, Post } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Db, Prisma } from '@datoflow/db';
import { endOfToday, localDate, orderStuck, planDay } from '@datoflow/domain';
import {
  createTaskSchema,
  emptyQuerySchema,
  taskListQuerySchema,
  updateTaskSchema,
  type CreateTaskInput,
  type MyDayDto,
  type Page,
  type TaskDto,
  type TaskListQuery,
  type UpdateTaskInput,
} from '@datoflow/shared';
import { CurrentMembership, CurrentUser, OrgRoute } from '../auth/guards.js';
import { ApiError } from '../http/errors.js';
import { pageArgs, toPage } from '../http/pagination.js';
import type { AuthUser, Membership } from '../http/request.js';
import { IdParam, ZBody, ZQuery } from '../http/validation.js';
import { editableLead, toLeadSummary, visibleLead, withMember } from '../leads/lead-service.js';
import { DB } from '../tokens.js';
import { createTask, TASK_INCLUDE, toTaskDto, updateTask, visibleTask } from './task-service.js';

const STATUS: Record<TaskListQuery['status'], Prisma.TaskWhereInput> = {
  open: { status: 'OPEN' },
  done: { status: 'DONE' },
  cancelled: { status: 'CANCELLED' },
  all: {},
};

@ApiTags('Tasks')
@Controller('v1/orgs/:orgId')
export class TasksController {
  constructor(@Inject(DB) private readonly db: Db) {}

  @Get('tasks')
  @OrgRoute('leads.view')
  @ApiOperation({
    summary:
      "Tasks, earliest due first (TASK-01). A lead's tasks with `leadId`; Sales Reps otherwise see only their own",
  })
  list(
    @CurrentMembership() membership: Membership,
    @CurrentUser() user: AuthUser,
    @ZQuery(taskListQuerySchema) query: TaskListQuery,
  ): Promise<Page<TaskDto>> {
    return withMember(this.db, membership, user, async (tx, _org, member) => {
      const and: Prisma.TaskWhereInput[] = [STATUS[query.status]];
      if (query.leadId) {
        await visibleLead(tx, member, query.leadId);
        and.push({ leadId: query.leadId });
      }
      const assignee = query.assignee === 'me' ? member.userId : query.assignee;
      if (member.role === 'REP' && !query.leadId && assignee && assignee !== member.userId) {
        throw ApiError.forbidden("Sales Reps see only their own tasks, or a lead's tasks");
      }
      if (assignee) and.push({ assigneeId: assignee });
      else if (member.role === 'REP' && !query.leadId) and.push({ assigneeId: member.userId });

      const now = new Date();
      const rows = await tx.task.findMany({
        where: { AND: and },
        include: TASK_INCLUDE,
        orderBy: [{ dueAt: 'asc' }, { id: 'asc' }],
        ...pageArgs(query),
      });
      return toPage(rows, query, (t) => toTaskDto(t, member, now));
    });
  }

  @Post('tasks')
  @HttpCode(201)
  @OrgRoute('leads.view')
  @ApiOperation({
    summary:
      'Create a task on a lead (TASK-01). The assignee must be a member; Sales Reps assign only themselves',
  })
  create(
    @CurrentMembership() membership: Membership,
    @CurrentUser() user: AuthUser,
    @ZBody(createTaskSchema) body: CreateTaskInput,
  ): Promise<TaskDto> {
    return withMember(this.db, membership, user, async (tx, org, member) => {
      const lead = await editableLead(tx, member, body.leadId);
      return toTaskDto(await createTask(tx, org, member, lead, body), member);
    });
  }

  @Patch('tasks/:taskId')
  @OrgRoute('leads.view')
  @ApiOperation({ summary: 'Change, complete, cancel or reschedule a task. Sales Reps: own tasks' })
  update(
    @CurrentMembership() membership: Membership,
    @CurrentUser() user: AuthUser,
    @IdParam('taskId') taskId: string,
    @ZBody(updateTaskSchema) body: UpdateTaskInput,
  ): Promise<TaskDto> {
    return withMember(this.db, membership, user, async (tx, org, member) => {
      const task = await visibleTask(tx, member, taskId);
      return toTaskDto(await updateTask(tx, org, member, task, body), member);
    });
  }

  @Get('me/day')
  @OrgRoute('leads.view')
  @ApiOperation({
    summary: 'My day (TASK-05): overdue next steps, then those due today, then your stuck leads',
  })
  day(
    @CurrentMembership() membership: Membership,
    @CurrentUser() user: AuthUser,
    @ZQuery(emptyQuerySchema) _query: Record<string, never>,
  ): Promise<MyDayDto> {
    return withMember(this.db, membership, user, async (tx, org, member) => {
      const now = new Date();
      // Next steps on leads still open and unarchived. A closed lead needs no next step.
      const tasks = await tx.task.findMany({
        where: {
          assigneeId: member.userId,
          status: 'OPEN',
          dueAt: { lt: endOfToday(now, org.timezone) },
          lead: { archivedAt: null, stage: { kind: 'OPEN' } },
        },
        include: TASK_INCLUDE,
        orderBy: [{ dueAt: 'asc' }, { id: 'asc' }],
        take: 200,
      });
      const { overdue, today } = planDay(tasks, now, org.timezone);
      const leads = await tx.lead.findMany({
        where: {
          ownerId: member.userId,
          archivedAt: null,
          stage: { kind: 'OPEN' },
          OR: [{ slaDueAt: { lt: now } }, { nextStepDueAt: { lt: now } }],
        },
        include: {
          owner: { select: { name: true } },
          stage: { select: { kind: true, slaHours: true } },
        },
        take: 200,
      });
      const stuck = orderStuck(
        leads.map((l) => ({ ...l, kind: l.stage.kind })),
        now,
      );
      return {
        date: localDate(now, org.timezone),
        overdue: overdue.map((t) => toTaskDto(t, member, now)),
        today: today.map((t) => toTaskDto(t, member, now)),
        stuck: stuck.map((l) => toLeadSummary(l, now)),
      };
    });
  }
}
