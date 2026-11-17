/**
 * One run of one workflow version for one event, as an explicit state machine:
 *
 *   QUEUED → RUNNING → SUCCEEDED | SKIPPED | CANCELLED | FAILED → (retry) → DEAD
 *
 * - SKIPPED is decided at dispatch (loop protection or false conditions) and never runs.
 * - FAILED means an attempt failed and another is scheduled. DEAD means no more automatic attempts.
 * - Pausing the workflow cancels runs that are waiting: QUEUED, or FAILED with a retry pending.
 * - A manual retry puts a FAILED or DEAD run back in the queue (WF-06).
 */
export const EXECUTION_STATUSES = [
  'QUEUED',
  'RUNNING',
  'SUCCEEDED',
  'SKIPPED',
  'CANCELLED',
  'FAILED',
  'DEAD',
] as const;
export type ExecutionStatus = (typeof EXECUTION_STATUSES)[number];

const TRANSITIONS: Record<ExecutionStatus, readonly ExecutionStatus[]> = {
  QUEUED: ['RUNNING', 'CANCELLED'],
  RUNNING: ['SUCCEEDED', 'FAILED', 'DEAD'],
  FAILED: ['RUNNING', 'CANCELLED', 'QUEUED'],
  DEAD: ['QUEUED'],
  SUCCEEDED: [],
  SKIPPED: [],
  CANCELLED: [],
};

export function canTransition(from: ExecutionStatus, to: ExecutionStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

/** Statuses a run can be claimed from, to start an attempt. */
export const CLAIMABLE: readonly ExecutionStatus[] = ['QUEUED', 'FAILED'];
/** Statuses that pausing a workflow cancels (WF-05). */
export const CANCELLABLE: readonly ExecutionStatus[] = ['QUEUED', 'FAILED'];

export function isFinal(status: ExecutionStatus): boolean {
  return TRANSITIONS[status].length === 0;
}

/** WF-06: a manual retry is allowed only for FAILED or DEAD runs. */
export function canRetryManually(status: ExecutionStatus): boolean {
  return status === 'FAILED' || status === 'DEAD';
}

// ---------------------------------------------------------------------------
// Retries (WF-08)
// ---------------------------------------------------------------------------

/** WF-08: up to 5 attempts. */
export const MAX_ATTEMPTS = 5;

/**
 * Why an action failed. Validation, permission and not-found errors fail fast: trying again
 * cannot help. Anything else (a lost connection, a timeout, a provider error) is retried.
 */
export type FailureKind = 'VALIDATION' | 'PERMISSION' | 'NOT_FOUND' | 'TRANSIENT';

export class ActionError extends Error {
  constructor(
    readonly kind: FailureKind,
    message: string,
  ) {
    super(message);
    this.name = 'ActionError';
  }
}

export function isRetryable(err: unknown): boolean {
  return !(err instanceof ActionError) || err.kind === 'TRANSIENT';
}

export interface Backoff {
  /** Delay before the second attempt. Each later one doubles it. */
  baseMs: number;
  /** No delay grows beyond this. */
  capMs: number;
}

export const DEFAULT_BACKOFF: Backoff = { baseMs: 30_000, capMs: 60 * 60_000 };

/**
 * Exponential backoff with jitter: the delay after attempt `n` is between half and all of
 * `base * 2^(n-1)`, capped. Jitter spreads retries so failures do not all come back at once.
 */
export function backoffMs(
  attempt: number,
  backoff: Backoff = DEFAULT_BACKOFF,
  random: () => number = Math.random,
): number {
  const exp = Math.min(backoff.capMs, backoff.baseMs * 2 ** Math.max(0, attempt - 1));
  return Math.floor(exp / 2 + random() * (exp / 2));
}

export type FailureDecision =
  | { status: 'FAILED'; retryAt: Date }
  | { status: 'DEAD'; reason: 'NOT_RETRYABLE' | 'ATTEMPTS_EXHAUSTED' };

/** What happens after attempt `attempt` failed with `err`. */
export function decideFailure(
  attempt: number,
  err: unknown,
  now: Date,
  backoff: Backoff = DEFAULT_BACKOFF,
  random: () => number = Math.random,
): FailureDecision {
  if (!isRetryable(err)) return { status: 'DEAD', reason: 'NOT_RETRYABLE' };
  if (attempt >= MAX_ATTEMPTS) return { status: 'DEAD', reason: 'ATTEMPTS_EXHAUSTED' };
  return {
    status: 'FAILED',
    retryAt: new Date(now.getTime() + backoffMs(attempt, backoff, random)),
  };
}

// ---------------------------------------------------------------------------
// Loop protection (WF-09)
// ---------------------------------------------------------------------------

/** WF-09: events caused by workflows nest at most this deep. A user's change is depth 0. */
export const MAX_DEPTH = 3;

export const SKIP_REASONS = [
  'DEPTH_LIMIT',
  'SELF_TRIGGER',
  'PLAN_LIMIT',
  'CONDITIONS_NOT_MET',
  'LEAD_NOT_FOUND',
] as const;
export type SkipReason = (typeof SKIP_REASONS)[number];

export const SKIP_REASON_LABEL: Record<SkipReason, string> = {
  DEPTH_LIMIT: `Skipped: the event was more than ${MAX_DEPTH} workflow steps away from a person's change`,
  SELF_TRIGGER: "Skipped: the event came from this workflow's own action",
  PLAN_LIMIT: "Skipped: this month's workflow runs on the plan are used up",
  CONDITIONS_NOT_MET: 'Skipped: the conditions were not met',
  LEAD_NOT_FOUND: 'Skipped: the lead no longer exists',
};

export interface AdmissionInput {
  depth: number;
  /** The event was raised by a run of this same workflow. */
  selfTriggered: boolean;
  /** Runs this month that count against the plan. */
  runsThisMonth: number;
  /** The plan's monthly run limit; null for unlimited. Sample runs pass null: they never count. */
  monthlyCap: number | null;
}

export type Admission = { ok: true } | { ok: false; reason: SkipReason };

/** Whether an event may start a run of a workflow (WF-09). Checked before conditions. */
export function admit(input: AdmissionInput): Admission {
  if (input.depth > MAX_DEPTH) return { ok: false, reason: 'DEPTH_LIMIT' };
  if (input.selfTriggered) return { ok: false, reason: 'SELF_TRIGGER' };
  if (input.monthlyCap !== null && input.runsThisMonth >= input.monthlyCap) {
    return { ok: false, reason: 'PLAN_LIMIT' };
  }
  return { ok: true };
}

/** The first instant of the UTC month that holds `now`. Monthly caps count from here. */
export function monthStart(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

// ---------------------------------------------------------------------------
// Idempotency keys (WF-07)
// ---------------------------------------------------------------------------

/** The key of one step's side effect: the same run and step always produce the same key. */
export function stepKey(executionId: string, stepIndex: number): string {
  return `wf:${executionId}:${stepIndex}`;
}

/** The BullMQ queue that carries outbox events and workflow runs. */
export const WORKFLOW_QUEUE = 'workflows';

/**
 * BullMQ job ids. Adding a job whose id already exists is a no-op, so an event is dispatched once
 * per publish and each attempt is queued once. `round` counts manual retries, which restart the
 * attempt count.
 */
export const jobId = {
  event: (eventId: string) => `event-${eventId}`,
  run: (executionId: string, round: number, attempt: number) =>
    `run-${executionId}-${round}-${attempt}`,
};
