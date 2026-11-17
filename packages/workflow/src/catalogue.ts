/**
 * The fixed workflow catalogue (WF-02, WF-03, WF-04). Only what is listed here exists: there is no
 * free-form scripting. The API validates definitions against it when a workflow is saved.
 */

/** Triggers (WF-02). Each is an outbox event type. */
export const TRIGGERS = [
  'lead.created',
  'lead.stage_changed',
  'lead.assigned',
  'task.deadline_reached',
] as const;
export type Trigger = (typeof TRIGGERS)[number];

export const TRIGGER_LABEL: Record<Trigger, string> = {
  'lead.created': 'A lead is created',
  'lead.stage_changed': 'A lead moves to another stage',
  'lead.assigned': 'A lead is assigned or reassigned',
  'task.deadline_reached': 'A next step reaches its due time',
};

/** Condition fields (WF-03). All conditions of a workflow are AND-ed. */
export const CONDITION_FIELDS = ['source', 'stage', 'assignee', 'priority'] as const;
export type ConditionField = (typeof CONDITION_FIELDS)[number];

export const CONDITION_FIELD_LABEL: Record<ConditionField, string> = {
  source: 'Source',
  stage: 'Stage',
  assignee: 'Assignee',
  priority: 'Priority',
};

export const CONDITION_OPERATORS = ['is', 'is_any_of', 'is_none_of'] as const;
export type ConditionOperator = (typeof CONDITION_OPERATORS)[number];

export const CONDITION_OPERATOR_LABEL: Record<ConditionOperator, string> = {
  is: 'is',
  is_any_of: 'is any of',
  is_none_of: 'is none of',
};

/** The assignee value that stands for "nobody": a lead in the unassigned pool. */
export const UNASSIGNED = 'unassigned';

export interface Condition {
  field: ConditionField;
  operator: ConditionOperator;
  /** Stage ids, user ids (or `unassigned`), source codes or priority codes. */
  values: string[];
}

/** Actions (WF-04). */
export const ACTION_TYPES = [
  'assign',
  'create_task',
  'send_email',
  'notify',
  'update_field',
] as const;
export type ActionType = (typeof ACTION_TYPES)[number];

export const ACTION_LABEL: Record<ActionType, string> = {
  assign: 'Assign the lead',
  create_task: 'Create a task',
  send_email: 'Schedule an email',
  notify: 'Send an internal notification',
  update_field: 'Update a field',
};

/** The only lead fields an action may change (WF-04). Anything else is refused on save. */
export const UPDATABLE_FIELDS = ['priority', 'stage', 'owner', 'tags'] as const;
export type UpdatableField = (typeof UPDATABLE_FIELDS)[number];

export const PRIORITIES = ['LOW', 'NORMAL', 'HIGH'] as const;
export type PriorityValue = (typeof PRIORITIES)[number];

export const TASK_KINDS = ['CALL', 'EMAIL', 'WHATSAPP', 'MEETING', 'OTHER'] as const;
export type TaskKind = (typeof TASK_KINDS)[number];

export interface AssignAction {
  type: 'assign';
  /** `user`: always the one member in `userIds`. `round_robin`: each run takes the next one. */
  mode: 'user' | 'round_robin';
  userIds: string[];
}

export interface CreateTaskAction {
  type: 'create_task';
  title: string;
  taskType: TaskKind;
  /** Due this many hours after the run. */
  dueInHours: number;
  priority: PriorityValue;
  /** A member, or null for the lead's owner at the time of the run. */
  assigneeId: string | null;
}

export interface SendEmailAction {
  type: 'send_email';
  to: 'lead' | 'owner';
  subject: string;
  body: string;
  /** Sent this many minutes after the run, up to 30 days. */
  delayMinutes: number;
}

export interface NotifyAction {
  type: 'notify';
  to: 'owner' | 'admins' | 'user';
  /** Required when `to` is `user`. */
  userId: string | null;
  message: string;
}

export type UpdateFieldAction =
  | { type: 'update_field'; field: 'priority'; value: PriorityValue }
  | { type: 'update_field'; field: 'stage'; value: string }
  | { type: 'update_field'; field: 'owner'; value: string | null }
  | { type: 'update_field'; field: 'tags'; op: 'add' | 'remove'; value: string[] };

export type Action =
  AssignAction | CreateTaskAction | SendEmailAction | NotifyAction | UpdateFieldAction;

export interface Definition {
  trigger: Trigger;
  conditions: Condition[];
  actions: Action[];
}

export const MAX_CONDITIONS = 10;
/** WF-01: up to 10 ordered actions. */
export const MAX_ACTIONS = 10;
/** WF-04: emails are scheduled up to 30 days ahead. */
export const MAX_EMAIL_DELAY_MINUTES = 30 * 24 * 60;
export const MAX_TASK_DUE_HOURS = 30 * 24;
export const MAX_ROUND_ROBIN = 25;
export const MAX_TAGS = 20;

export interface DefinitionError {
  path: string;
  message: string;
}

/**
 * Rules that span fields, checked when a workflow is saved. Shapes, enums and lengths are checked
 * by the request schema first; references (stages, members) by the API against the database.
 */
export function checkDefinition(def: Definition): DefinitionError[] {
  const errors: DefinitionError[] = [];
  if (def.conditions.length > MAX_CONDITIONS) {
    errors.push({ path: 'conditions', message: `Use at most ${MAX_CONDITIONS} conditions` });
  }
  if (def.actions.length === 0) {
    errors.push({ path: 'actions', message: 'Add at least one action' });
  }
  if (def.actions.length > MAX_ACTIONS) {
    errors.push({ path: 'actions', message: `Use at most ${MAX_ACTIONS} actions` });
  }
  def.conditions.forEach((c, i) => {
    const path = `conditions.${i}.values`;
    if (c.values.length === 0) errors.push({ path, message: 'Choose at least one value' });
    if (c.operator === 'is' && c.values.length > 1) {
      errors.push({ path, message: 'Choose one value, or use "is any of"' });
    }
    if (new Set(c.values).size !== c.values.length) {
      errors.push({ path, message: 'Each value can be chosen once' });
    }
  });
  def.actions.forEach((a, i) => {
    const path = `actions.${i}`;
    switch (a.type) {
      case 'assign': {
        const distinct = new Set(a.userIds).size === a.userIds.length;
        if (!distinct) errors.push({ path: `${path}.userIds`, message: 'Choose each member once' });
        if (a.mode === 'user' && a.userIds.length !== 1) {
          errors.push({ path: `${path}.userIds`, message: 'Choose one member' });
        }
        if (
          a.mode === 'round_robin' &&
          (a.userIds.length < 2 || a.userIds.length > MAX_ROUND_ROBIN)
        ) {
          errors.push({
            path: `${path}.userIds`,
            message: `Round-robin needs 2 to ${MAX_ROUND_ROBIN} members`,
          });
        }
        break;
      }
      case 'create_task':
        if (a.dueInHours < 0 || a.dueInHours > MAX_TASK_DUE_HOURS) {
          errors.push({
            path: `${path}.dueInHours`,
            message: `Due within ${MAX_TASK_DUE_HOURS / 24} days`,
          });
        }
        break;
      case 'send_email':
        if (a.delayMinutes < 0 || a.delayMinutes > MAX_EMAIL_DELAY_MINUTES) {
          errors.push({
            path: `${path}.delayMinutes`,
            message: 'Emails can be scheduled up to 30 days ahead',
          });
        }
        break;
      case 'notify':
        if (a.to === 'user' && !a.userId) {
          errors.push({ path: `${path}.userId`, message: 'Choose who to notify' });
        }
        break;
      case 'update_field':
        if (!(UPDATABLE_FIELDS as readonly string[]).includes(a.field)) {
          errors.push({
            path: `${path}.field`,
            message: 'Only priority, stage, owner and tags can be updated',
          });
        }
        if (a.field === 'tags' && (a.value.length === 0 || a.value.length > MAX_TAGS)) {
          errors.push({ path: `${path}.value`, message: `Give 1 to ${MAX_TAGS} tags` });
        }
        break;
    }
  });
  return errors;
}

/** Member ids a definition refers to, so the API can check they belong to the organization. */
export function referencedUserIds(def: Definition): string[] {
  const ids = new Set<string>();
  for (const c of def.conditions) {
    if (c.field === 'assignee') c.values.filter((v) => v !== UNASSIGNED).forEach((v) => ids.add(v));
  }
  for (const a of def.actions) {
    if (a.type === 'assign') a.userIds.forEach((v) => ids.add(v));
    if (a.type === 'create_task' && a.assigneeId) ids.add(a.assigneeId);
    if (a.type === 'notify' && a.to === 'user' && a.userId) ids.add(a.userId);
    if (a.type === 'update_field' && a.field === 'owner' && a.value) ids.add(a.value);
  }
  return [...ids];
}

/** Stage ids a definition refers to. Actions may move a lead only to an open stage. */
export function referencedStageIds(def: Definition): { conditions: string[]; actions: string[] } {
  return {
    conditions: [
      ...new Set(def.conditions.filter((c) => c.field === 'stage').flatMap((c) => c.values)),
    ],
    actions: [
      ...new Set(
        def.actions.flatMap((a) =>
          a.type === 'update_field' && a.field === 'stage' ? [a.value] : [],
        ),
      ),
    ],
  };
}
