import { PRIORITY_LABEL, SOURCE_LABEL, TASK_TYPE_LABEL } from '@datoflow/domain';
import type { ExecutionDto, WorkflowStatusCode } from '@datoflow/shared';
import { Badge, StatusBadge } from '@datoflow/ui';
import {
  CONDITION_FIELD_LABEL,
  CONDITION_OPERATOR_LABEL,
  SKIP_REASON_LABEL,
  TRIGGER_LABEL,
  UNASSIGNED,
  type Action,
  type Condition,
  type ExecutionStatus,
} from '@datoflow/workflow';
import { CircleSlash, Clock, Pause, RotateCw } from 'lucide-react';
import type { Lookups } from '@/lib/lookups';

export { TRIGGER_LABEL };

/** A workflow's status, as a word with an icon. */
export function WorkflowStatus({ status }: { status: WorkflowStatusCode }) {
  if (status === 'ACTIVE') return <StatusBadge status="done">Active</StatusBadge>;
  if (status === 'PAUSED')
    return (
      <Badge tone="sulfur">
        <Pause aria-hidden className="size-3.5" strokeWidth={1.75} />
        Paused
      </Badge>
    );
  return <Badge tone="limestone">Draft</Badge>;
}

const RUN_TEXT: Record<ExecutionStatus, string> = {
  QUEUED: 'Queued',
  RUNNING: 'Running',
  SUCCEEDED: 'Succeeded',
  SKIPPED: 'Skipped',
  CANCELLED: 'Cancelled',
  FAILED: 'Failed, retrying',
  DEAD: 'Dead',
};

/**
 * A run's status. Dead needs a person: Ember. A failed run waiting for its next attempt: Sulfur.
 * Never colour alone.
 */
export function RunStatus({ status }: { status: ExecutionStatus }) {
  switch (status) {
    case 'SUCCEEDED':
      return <StatusBadge status="done">{RUN_TEXT[status]}</StatusBadge>;
    case 'DEAD':
      return <StatusBadge status="attention">{RUN_TEXT[status]}</StatusBadge>;
    case 'FAILED':
      return (
        <Badge tone="sulfur">
          <RotateCw aria-hidden className="size-3.5" strokeWidth={1.75} />
          {RUN_TEXT[status]}
        </Badge>
      );
    case 'QUEUED':
    case 'RUNNING':
      return (
        <Badge tone="limestone" className="bg-pumice">
          <Clock aria-hidden className="size-3.5" strokeWidth={1.75} />
          {RUN_TEXT[status]}
        </Badge>
      );
    default:
      return (
        <Badge tone="limestone" className="bg-pumice">
          <CircleSlash aria-hidden className="size-3.5" strokeWidth={1.75} />
          {RUN_TEXT[status]}
        </Badge>
      );
  }
}

export const EVENT_LABEL: Record<string, string> = {
  'lead.created': 'Lead created',
  'lead.stage_changed': 'Stage changed',
  'lead.assigned': 'Lead assigned',
  'task.deadline_reached': 'Next step due',
};

/** Why a run did not run, or what went wrong, in one line. */
export function runNote(e: Pick<ExecutionDto, 'status' | 'skipReason' | 'error'>): string | null {
  if (e.status === 'SKIPPED' && e.skipReason) return SKIP_REASON_LABEL[e.skipReason];
  if (e.error && e.status !== 'SUCCEEDED') return e.error;
  return null;
}

function person(lookups: Lookups, id: string | null) {
  if (!id) return 'the lead owner';
  return lookups.assigneeById.get(id)?.name ?? 'a former member';
}

function hours(n: number) {
  if (n === 0) return 'right away';
  if (n % 24 === 0) return `in ${n / 24} ${n === 24 ? 'day' : 'days'}`;
  return `in ${n} ${n === 1 ? 'hour' : 'hours'}`;
}

function minutes(n: number) {
  if (n === 0) return 'right away';
  if (n % 1440 === 0) return `after ${n / 1440} ${n === 1440 ? 'day' : 'days'}`;
  if (n % 60 === 0) return `after ${n / 60} ${n === 60 ? 'hour' : 'hours'}`;
  return `after ${n} minutes`;
}

/** One action as a sentence, for the builder summary and the run log. */
export function describeAction(a: Action, lookups: Lookups): string {
  switch (a.type) {
    case 'assign':
      return a.mode === 'user'
        ? `Assign to ${person(lookups, a.userIds[0] ?? null)}`
        : `Assign in turn to ${a.userIds.map((u) => person(lookups, u)).join(', ')}`;
    case 'create_task':
      return `Create a ${TASK_TYPE_LABEL[a.taskType].toLowerCase()} task "${a.title}" for ${person(lookups, a.assigneeId)}, due ${hours(a.dueInHours)}`;
    case 'send_email':
      return `Email the ${a.to === 'lead' ? 'lead' : 'owner'} "${a.subject}" ${minutes(a.delayMinutes)}`;
    case 'notify':
      return `Notify ${a.to === 'owner' ? 'the owner' : a.to === 'admins' ? 'Owners and Admins' : person(lookups, a.userId)}: "${a.message}"`;
    case 'update_field':
      switch (a.field) {
        case 'priority':
          return `Set priority to ${PRIORITY_LABEL[a.value].toLowerCase()}`;
        case 'stage':
          return `Move to ${lookups.stageById.get(a.value)?.name ?? 'a removed stage'}`;
        case 'owner':
          return a.value
            ? `Make ${person(lookups, a.value)} the owner`
            : 'Move to the unassigned pool';
        case 'tags':
          return `${a.op === 'add' ? 'Add' : 'Remove'} ${a.value.length === 1 ? 'tag' : 'tags'} ${a.value.join(', ')}`;
      }
  }
}

function conditionValue(c: Condition, v: string, lookups: Lookups) {
  switch (c.field) {
    case 'source':
      return SOURCE_LABEL[v as keyof typeof SOURCE_LABEL] ?? v;
    case 'priority':
      return PRIORITY_LABEL[v as keyof typeof PRIORITY_LABEL] ?? v;
    case 'stage':
      return lookups.stageById.get(v)?.name ?? 'a removed stage';
    case 'assignee':
      return v === UNASSIGNED ? 'Unassigned' : person(lookups, v);
  }
}

export function describeCondition(c: Condition, lookups: Lookups): string {
  const values = c.values.map((v) => conditionValue(c, v, lookups));
  return `${CONDITION_FIELD_LABEL[c.field]} ${CONDITION_OPERATOR_LABEL[c.operator]} ${values.join(', ')}`;
}
