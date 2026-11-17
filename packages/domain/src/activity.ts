/**
 * Activity types on a lead's timeline (LEAD-06): changes, notes, touches, tasks, radar flags and
 * workflow actions. A workflow's own changes (assign, stage, task) use the usual type with the
 * WORKFLOW actor; WORKFLOW_ACTION records the actions with no other entry, such as an email.
 */
export const ACTIVITY_TYPES = [
  'CREATED',
  'UPDATED',
  'STAGE_CHANGED',
  'ASSIGNED',
  'NOTE',
  'ARCHIVED',
  'RESTORED',
  'DUPLICATE_FOUND',
  'TOUCH',
  'TASK_CREATED',
  'TASK_UPDATED',
  'TASK_COMPLETED',
  'TASK_CANCELLED',
  'STUCK',
  'WORKFLOW_ACTION',
] as const;
export type ActivityType = (typeof ACTIVITY_TYPES)[number];

export type ActorType = 'USER' | 'WORKFLOW' | 'SYSTEM';

/**
 * Activity that resets the stage SLA clock. Editing a field such as a phone number is logged
 * but does not count as following up.
 */
export const SLA_RESETTING_ACTIVITY: ReadonlySet<ActivityType> = new Set([
  'CREATED',
  'STAGE_CHANGED',
  'ASSIGNED',
  'NOTE',
  'TOUCH',
]);

/** How an actor is named on the timeline. Workflow changes read "Workflow: name" (LEAD-06). */
export function actorName(actor: { type: ActorType; label: string | null }): string {
  switch (actor.type) {
    case 'WORKFLOW':
      return `Workflow: ${actor.label ?? 'deleted workflow'}`;
    case 'SYSTEM':
      return actor.label ?? 'DatoFlow';
    case 'USER':
      return actor.label ?? 'Former member';
  }
}

/** Lead fields whose changes are written to the timeline, in display order. */
export const TRACKED_FIELDS = [
  'name',
  'company',
  'email',
  'phone',
  'source',
  'priority',
  'dealValue',
  'notes',
  'utm',
  'tags',
] as const;
export type TrackedField = (typeof TRACKED_FIELDS)[number];

/** The tracked fields that differ between two versions of a lead, with before and after values. */
export function diffFields(
  before: Partial<Record<TrackedField, unknown>>,
  after: Partial<Record<TrackedField, unknown>>,
): { field: TrackedField; from: unknown; to: unknown }[] {
  const changes: { field: TrackedField; from: unknown; to: unknown }[] = [];
  for (const field of TRACKED_FIELDS) {
    if (!(field in after)) continue;
    const from = before[field] ?? null;
    const to = after[field] ?? null;
    if (JSON.stringify(from) !== JSON.stringify(to)) changes.push({ field, from, to });
  }
  return changes;
}
