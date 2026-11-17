import { z } from 'zod';
import { createNoteSchema, type LeadSummaryDto, type PriorityCode } from './leads.js';
import { idParam } from './schemas.js';

export const TASK_TYPES = ['CALL', 'EMAIL', 'WHATSAPP', 'MEETING', 'OTHER'] as const;
export const TASK_STATUSES = ['OPEN', 'DONE', 'CANCELLED'] as const;
export const TOUCH_CHANNELS = ['CALL', 'EMAIL', 'WHATSAPP', 'MEETING'] as const;

export type TaskTypeCode = (typeof TASK_TYPES)[number];
export type TaskStatusCode = (typeof TASK_STATUSES)[number];
export type TouchChannelCode = (typeof TOUCH_CHANNELS)[number];

const priority = z.enum(['LOW', 'NORMAL', 'HIGH']);
/** An instant with an explicit offset, such as 2026-11-17T09:30:00+05:30. Stored in UTC. */
const instant = z.iso.datetime({ offset: true }).transform((v) => new Date(v));

/** The fields of a task, or of the next step set with a touch (TASK-01). */
const taskFields = {
  title: z.string().trim().min(1, 'Say what the next step is').max(200),
  type: z.enum(TASK_TYPES),
  dueAt: instant,
  priority: priority.default('NORMAL'),
  /** A member of the organization. Defaults to the caller. */
  assigneeId: idParam.optional(),
};

export const nextStepSchema = z.strictObject(taskFields);
export type NextStepInput = z.infer<typeof nextStepSchema>;

export const createTaskSchema = z.strictObject({ leadId: idParam, ...taskFields });
export type CreateTaskInput = z.infer<typeof createTaskSchema>;

export const updateTaskSchema = z
  .strictObject({
    title: taskFields.title,
    type: taskFields.type,
    dueAt: instant,
    priority,
    assigneeId: idParam,
    status: z.enum(TASK_STATUSES),
  })
  .partial()
  .refine((v) => Object.keys(v).length > 0, 'Send at least one field');
export type UpdateTaskInput = z.infer<typeof updateTaskSchema>;

export const taskListQuerySchema = z.strictObject({
  /** `me`, or a member's user id. */
  assignee: z.union([z.literal('me'), idParam]).optional(),
  leadId: idParam.optional(),
  status: z.enum(['open', 'done', 'cancelled', 'all']).default('open'),
  cursor: idParam.optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});
export type TaskListQuery = z.infer<typeof taskListQuerySchema>;

/**
 * A touch: a call, email, WhatsApp message or meeting with the lead (TASK-02). On an open lead it
 * needs a new next step, unless `close` moves the lead to Won or Lost.
 */
export const touchSchema = z.strictObject({
  type: z.literal('TOUCH'),
  channel: z.enum(TOUCH_CHANNELS),
  text: z.string().trim().max(5000).optional(),
  nextStep: nextStepSchema.optional(),
  /** Open tasks this touch took care of. They are marked done. */
  completeTaskIds: z.array(idParam).max(20).optional(),
  /** Close the lead with this touch, as Won or Lost. */
  close: z
    .strictObject({
      stageId: idParam,
      lossReasonId: idParam.optional(),
      dealValue: z.number().nonnegative().max(1e12).multipleOf(0.01).optional(),
    })
    .optional(),
});
export type TouchInput = z.infer<typeof touchSchema>;

/** POST …/leads/:id/activities takes a note or a touch. */
export const createActivitySchema = z.discriminatedUnion('type', [createNoteSchema, touchSchema]);
export type CreateActivityInput = z.infer<typeof createActivitySchema>;

export const notificationListQuerySchema = z.strictObject({
  unread: z
    .enum(['true', 'false'])
    .transform((v) => v === 'true')
    .optional(),
  cursor: idParam.optional(),
  limit: z.coerce.number().int().min(1).max(100).default(30),
});
export type NotificationListQuery = z.infer<typeof notificationListQuerySchema>;

// ---- Output DTOs ----

export interface TaskDto {
  id: string;
  leadId: string;
  leadName: string;
  leadCompany: string | null;
  title: string;
  type: TaskTypeCode;
  dueAt: string;
  priority: PriorityCode;
  assigneeId: string | null;
  assigneeName: string | null;
  status: TaskStatusCode;
  overdue: boolean;
  completedAt: string | null;
  createdAt: string;
  /** Whether the caller may change it: their own task, or any task for managers. */
  canEdit: boolean;
}

/** My day (TASK-05): overdue next steps, then today's, then stuck leads assigned to the caller. */
export interface MyDayDto {
  date: string;
  overdue: TaskDto[];
  today: TaskDto[];
  stuck: LeadSummaryDto[];
}

export interface TouchResultDto {
  activityId: string;
  nextStep: TaskDto | null;
  /** Set when the organization only warns and the touch had no next step. */
  warning: 'NEXT_STEP_MISSING' | null;
}

export const NOTIFICATION_KINDS = ['TASK_DUE_SOON', 'MEMBER_JOINED'] as const;
export type NotificationKind = (typeof NOTIFICATION_KINDS)[number];

export interface NotificationDto {
  id: string;
  kind: NotificationKind;
  payload: Record<string, unknown>;
  readAt: string | null;
  createdAt: string;
}
