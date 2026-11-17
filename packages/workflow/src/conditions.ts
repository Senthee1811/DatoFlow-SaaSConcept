import { UNASSIGNED, type Condition, type ConditionField } from './catalogue.js';

/**
 * What conditions are checked against, read when the event is dispatched. For lead events the
 * assignee is the lead's owner; for `task.deadline_reached` it is the task's assignee.
 */
export interface ConditionSubject {
  source: string;
  stage: string;
  /** Null when nobody is assigned. */
  assignee: string | null;
  priority: string;
}

function valueOf(subject: ConditionSubject, field: ConditionField): string {
  if (field === 'assignee') return subject.assignee ?? UNASSIGNED;
  return subject[field];
}

export function conditionHolds(condition: Condition, subject: ConditionSubject): boolean {
  const value = valueOf(subject, condition.field);
  switch (condition.operator) {
    case 'is':
      return condition.values[0] === value;
    case 'is_any_of':
      return condition.values.includes(value);
    case 'is_none_of':
      return !condition.values.includes(value);
  }
}

export type ConditionResult = { ok: true } | { ok: false; index: number; condition: Condition };

/** All conditions are AND-ed (WF-01). No conditions means the workflow always runs. */
export function evaluateConditions(
  conditions: Condition[],
  subject: ConditionSubject,
): ConditionResult {
  for (const [index, condition] of conditions.entries()) {
    if (!conditionHolds(condition, subject)) return { ok: false, index, condition };
  }
  return { ok: true };
}
