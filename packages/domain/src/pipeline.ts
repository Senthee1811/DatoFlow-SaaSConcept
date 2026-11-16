import type { FieldError } from './leads.js';

export type StageKind = 'OPEN' | 'WON' | 'LOST';

/** Default stage SLA in hours. A lead with no activity for longer is stuck. */
export const DEFAULT_SLA_HOURS = 72;
export const MAX_STAGES = 12;
export const MAX_SLA_HOURS = 24 * 365;

export interface StageTemplate {
  name: string;
  order: number;
  kind: StageKind;
  slaHours: number;
}

/** Every new organization starts with this pipeline: 4 open stages, Won and Lost (ORG-01). */
export const DEFAULT_PIPELINE: { name: string; stages: StageTemplate[] } = {
  name: 'Sales pipeline',
  stages: (
    [
      ['New', 'OPEN'],
      ['Contacted', 'OPEN'],
      ['Qualified', 'OPEN'],
      ['Proposal', 'OPEN'],
      ['Won', 'WON'],
      ['Lost', 'LOST'],
    ] as const
  ).map(([name, kind], order) => ({ name, order, kind, slaHours: DEFAULT_SLA_HOURS })),
};

/** Loss reasons every new organization starts with. Admins can change them. */
export const DEFAULT_LOSS_REASONS = [
  'No budget',
  'Chose a competitor',
  'No response',
  'Not a fit',
  'Bad timing',
];

// ---------------------------------------------------------------------------
// Stage configuration (PIPE-01)
// ---------------------------------------------------------------------------

export interface StageInput {
  id?: string | undefined;
  name: string;
  slaHours: number;
  kind: StageKind;
}

export interface CurrentStage {
  id: string;
  kind: StageKind;
  leadCount: number;
}

export type StagePlan =
  | { ok: true; removed: string[] }
  | { ok: false; code: 'INVALID_STAGES'; errors: FieldError[] }
  | { ok: false; code: 'STAGE_NOT_EMPTY'; stageIds: string[] };

/**
 * Checks a new stage list against the current one. The list order is the board order.
 * A stage that holds leads cannot be removed, or change between open and closed, until its
 * leads are moved.
 */
export function planStages(current: CurrentStage[], next: StageInput[]): StagePlan {
  const errors: FieldError[] = [];
  const kinds = next.map((s) => s.kind);
  if (next.length > MAX_STAGES)
    errors.push({ path: 'body.stages', message: `Use at most ${MAX_STAGES} stages` });
  if (!kinds.includes('OPEN'))
    errors.push({ path: 'body.stages', message: 'Keep at least one open stage' });
  if (kinds.filter((k) => k === 'WON').length !== 1) {
    errors.push({ path: 'body.stages', message: 'Mark exactly one stage as Won' });
  }
  if (kinds.filter((k) => k === 'LOST').length !== 1) {
    errors.push({ path: 'body.stages', message: 'Mark exactly one stage as Lost' });
  }
  const seen = new Set<string>();
  next.forEach((s, i) => {
    const key = s.name.trim().toLowerCase();
    if (seen.has(key))
      errors.push({ path: `body.stages.${i}.name`, message: 'Stage names must be different' });
    seen.add(key);
  });
  const known = new Map(current.map((s) => [s.id, s]));
  next.forEach((s, i) => {
    if (s.id && !known.has(s.id))
      errors.push({ path: `body.stages.${i}.id`, message: 'Unknown stage' });
  });
  const ids = next.map((s) => s.id).filter(Boolean);
  if (new Set(ids).size !== ids.length)
    errors.push({ path: 'body.stages', message: 'A stage appears twice' });
  if (errors.length) return { ok: false, code: 'INVALID_STAGES', errors };

  const kept = new Map(next.filter((s) => s.id).map((s) => [s.id!, s]));
  const blocked: string[] = [];
  const removed: string[] = [];
  for (const stage of current) {
    const after = kept.get(stage.id);
    if (!after) {
      if (stage.leadCount > 0) blocked.push(stage.id);
      else removed.push(stage.id);
    } else if ((after.kind === 'OPEN') !== (stage.kind === 'OPEN') && stage.leadCount > 0) {
      blocked.push(stage.id);
    }
  }
  if (blocked.length) return { ok: false, code: 'STAGE_NOT_EMPTY', stageIds: blocked };
  return { ok: true, removed };
}

// ---------------------------------------------------------------------------
// Stage moves (PIPE-03)
// ---------------------------------------------------------------------------

export type StageMove =
  | { ok: true }
  | {
      ok: false;
      code: 'LOSS_REASON_REQUIRED' | 'DEAL_VALUE_REQUIRED';
      path: string;
      message: string;
    };

/** Lost needs a loss reason. Won needs a deal value when the organization requires one. */
export function decideStageMove(input: {
  toKind: StageKind;
  lossReasonId: string | null | undefined;
  dealValue: number | null | undefined;
  wonRequiresDealValue: boolean;
}): StageMove {
  if (input.toKind === 'LOST' && !input.lossReasonId) {
    return {
      ok: false,
      code: 'LOSS_REASON_REQUIRED',
      path: 'body.lossReasonId',
      message: 'Choose why the lead was lost',
    };
  }
  if (
    input.toKind === 'WON' &&
    input.wonRequiresDealValue &&
    !(input.dealValue && input.dealValue > 0)
  ) {
    return {
      ok: false,
      code: 'DEAL_VALUE_REQUIRED',
      path: 'body.dealValue',
      message: 'Enter the deal value for a won lead',
    };
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// SLA
// ---------------------------------------------------------------------------

const HOUR = 60 * 60 * 1000;

/**
 * When an open lead becomes stuck for lack of activity: its last activity plus its stage SLA.
 * Closed leads are never stuck, so they have no due time.
 */
export function slaDueAt(lastActivityAt: Date, slaHours: number, kind: StageKind): Date | null {
  return kind === 'OPEN' ? new Date(lastActivityAt.getTime() + slaHours * HOUR) : null;
}

/**
 * Stuck by SLA: an open, unarchived lead with no activity for longer than its stage SLA.
 * Phase 3 adds the other half of the definition, an overdue next step.
 */
export function isStuckBySla(
  lead: { slaDueAt: Date | null; archivedAt: Date | null },
  now: Date,
): boolean {
  return (
    lead.archivedAt === null && lead.slaDueAt !== null && lead.slaDueAt.getTime() < now.getTime()
  );
}
