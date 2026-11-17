import {
  CONDITION_FIELDS,
  CONDITION_OPERATORS,
  EXECUTION_STATUSES,
  MAX_ACTIONS,
  MAX_CONDITIONS,
  MAX_ROUND_ROBIN,
  MAX_TAGS,
  PRIORITIES,
  TASK_KINDS,
  TRIGGERS,
  UNASSIGNED,
  type Action,
  type Condition,
  type Definition,
  type ExecutionStatus,
  type SkipReason,
  type Trigger,
} from '@datoflow/workflow';
import { z } from 'zod';
import { LEAD_SOURCES } from './leads.js';
import { idParam } from './schemas.js';

/**
 * Request schemas for workflows (WF-01 to WF-06). Shapes, enums and lengths are checked here;
 * rules across fields by `checkDefinition` in packages/workflow; references by the API.
 */

const priority = z.enum(PRIORITIES);
const text = (max: number, message: string) => z.string().trim().min(1, message).max(max);

/** A condition value: a stage id, a user id or `unassigned`, a source or a priority. */
const conditionSchema = z
  .strictObject({
    field: z.enum(CONDITION_FIELDS),
    operator: z.enum(CONDITION_OPERATORS),
    values: z.array(z.string().trim().min(1).max(64)).min(1, 'Choose at least one value').max(50),
  })
  .superRefine((c, ctx) => {
    const allowed: Record<string, readonly string[] | null> = {
      source: LEAD_SOURCES,
      priority: PRIORITIES,
      stage: null,
      assignee: null,
    };
    const list = allowed[c.field];
    c.values.forEach((v, i) => {
      const ok = list
        ? list.includes(v)
        : c.field === 'assignee' && v === UNASSIGNED
          ? true
          : idParam.safeParse(v).success;
      if (!ok) ctx.addIssue({ code: 'custom', path: ['values', i], message: 'Not a valid choice' });
    });
  });

const assignSchema = z.strictObject({
  type: z.literal('assign'),
  mode: z.enum(['user', 'round_robin']),
  userIds: z.array(idParam).min(1, 'Choose a member').max(MAX_ROUND_ROBIN),
});

const createTaskSchema = z.strictObject({
  type: z.literal('create_task'),
  title: text(200, 'Say what the task is'),
  taskType: z.enum(TASK_KINDS),
  dueInHours: z
    .number()
    .int()
    .min(0)
    .max(30 * 24),
  priority: priority.default('NORMAL'),
  assigneeId: idParam.nullable().default(null),
});

const sendEmailSchema = z.strictObject({
  type: z.literal('send_email'),
  to: z.enum(['lead', 'owner']),
  subject: text(200, 'Give the email a subject'),
  body: text(10_000, 'Write the email'),
  delayMinutes: z
    .number()
    .int()
    .min(0)
    .max(30 * 24 * 60, 'Emails can be scheduled up to 30 days ahead'),
});

const notifySchema = z.strictObject({
  type: z.literal('notify'),
  to: z.enum(['owner', 'admins', 'user']),
  userId: idParam.nullable().default(null),
  message: text(500, 'Write the notification'),
});

/** WF-04: only priority, stage, owner and tags. Any other field is refused when saving. */
const updateFieldSchema = z.discriminatedUnion('field', [
  z.strictObject({
    type: z.literal('update_field'),
    field: z.literal('priority'),
    value: priority,
  }),
  z.strictObject({ type: z.literal('update_field'), field: z.literal('stage'), value: idParam }),
  z.strictObject({
    type: z.literal('update_field'),
    field: z.literal('owner'),
    value: idParam.nullable(),
  }),
  z.strictObject({
    type: z.literal('update_field'),
    field: z.literal('tags'),
    op: z.enum(['add', 'remove']),
    value: z.array(z.string().trim().min(1).max(40)).min(1, 'Give at least one tag').max(MAX_TAGS),
  }),
]);

/** Actions are told apart by `type`, and field updates by `field`. */
const actionSchema = z.union([
  assignSchema,
  createTaskSchema,
  sendEmailSchema,
  notifySchema,
  updateFieldSchema,
]);

export const definitionSchema = z.strictObject({
  trigger: z.enum(TRIGGERS),
  conditions: z.array(conditionSchema).max(MAX_CONDITIONS).default([]),
  actions: z
    .array(actionSchema)
    .min(1, 'Add at least one action')
    .max(MAX_ACTIONS, `Use at most ${MAX_ACTIONS} actions`),
});
export type DefinitionInput = z.infer<typeof definitionSchema>;

const workflowName = text(80, 'Name the workflow');

export const createWorkflowSchema = z.strictObject({
  name: workflowName,
  definition: definitionSchema,
});
export type CreateWorkflowInput = z.infer<typeof createWorkflowSchema>;

/** Saving creates a new immutable version (WF-01). The name can change with it. */
export const createVersionSchema = z.strictObject({
  name: workflowName.optional(),
  definition: definitionSchema,
});
export type CreateVersionInput = z.infer<typeof createVersionSchema>;

export const workflowListQuerySchema = z.strictObject({
  cursor: idParam.optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});
export type WorkflowListQuery = z.infer<typeof workflowListQuerySchema>;

export const executionListQuerySchema = z.strictObject({
  workflowId: idParam.optional(),
  leadId: idParam.optional(),
  status: z.enum(EXECUTION_STATUSES).optional(),
  cursor: idParam.optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});
export type ExecutionListQuery = z.infer<typeof executionListQuerySchema>;

// The schemas and the engine's types must describe the same definitions.
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
const _sameDefinition: Same<DefinitionInput, Definition> = true;
const _sameAction: Same<DefinitionInput['actions'][number], Action> = true;
const _sameCondition: Same<DefinitionInput['conditions'][number], Condition> = true;
void [_sameDefinition, _sameAction, _sameCondition];

// ---- Output DTOs ----

export type WorkflowStatusCode = 'DRAFT' | 'ACTIVE' | 'PAUSED';

export interface WorkflowVersionDto {
  id: string;
  version: number;
  definition: Definition;
  createdAt: string;
  createdByName: string | null;
}

export interface WorkflowSummaryDto {
  id: string;
  name: string;
  status: WorkflowStatusCode;
  trigger: Trigger;
  latestVersion: number;
  /** The version that runs while the workflow is active. */
  activeVersion: number | null;
  isSample: boolean;
  /** Runs in the last 30 days, by outcome. */
  runs: { succeeded: number; failed: number; skipped: number };
  lastRunAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface WorkflowDto extends WorkflowSummaryDto {
  /** The latest version's definition: what the builder edits. */
  definition: Definition;
  versions: WorkflowVersionDto[];
}

export interface ExecutionStepDto {
  stepIndex: number;
  actionType: string;
  status: 'SUCCEEDED' | 'FAILED';
  attempt: number;
  result: Record<string, unknown> | null;
  error: string | null;
  finishedAt: string;
}

export interface ExecutionDto {
  id: string;
  workflowId: string;
  workflowName: string;
  version: number;
  eventId: string;
  eventType: string;
  leadId: string | null;
  leadName: string | null;
  status: ExecutionStatus;
  attempt: number;
  depth: number;
  skipReason: SkipReason | null;
  error: string | null;
  errorKind: string | null;
  nextAttemptAt: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  createdAt: string;
  /** WF-06: FAILED or DEAD runs can be retried by hand. */
  canRetry: boolean;
}

export interface ExecutionDetailDto extends ExecutionDto {
  manualRetries: number;
  /** The actions of the version that ran, so each step can be described. */
  actions: Action[];
  steps: ExecutionStepDto[];
}
