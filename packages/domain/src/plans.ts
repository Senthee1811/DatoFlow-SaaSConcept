/**
 * Plans and entitlements. This file is the only place the numbers live.
 * Prices are hypotheses, so change them here and nowhere else.
 */
export const PLAN_CODES = ['free', 'starter', 'growth', 'agency'] as const;
export type PlanCode = (typeof PLAN_CODES)[number];

export type LimitName = 'users' | 'leads' | 'activeWorkflows' | 'executionsPerMonth';

export interface Plan {
  code: PlanCode;
  name: string;
  usdPerMonth: number;
  /** `null` means unlimited. */
  limits: Record<LimitName, number | null>;
  adds: string[];
}

export const PLANS: Record<PlanCode, Plan> = {
  free: {
    code: 'free',
    name: 'Free',
    usdPerMonth: 0,
    limits: { users: 2, leads: 250, activeWorkflows: 1, executionsPerMonth: 500 },
    adds: ['Sample workspace', '1 capture form'],
  },
  starter: {
    code: 'starter',
    name: 'Starter',
    usdPerMonth: 19,
    limits: { users: 5, leads: 2_500, activeWorkflows: 5, executionsPerMonth: 5_000 },
    adds: ['Email reminders', 'CSV import and export'],
  },
  growth: {
    code: 'growth',
    name: 'Growth',
    usdPerMonth: 49,
    limits: { users: 15, leads: 15_000, activeWorkflows: 25, executionsPerMonth: 50_000 },
    adds: ['Webhooks', 'Per-stage SLAs', 'Analytics export'],
  },
  agency: {
    code: 'agency',
    name: 'Agency',
    usdPerMonth: 99,
    limits: { users: 25, leads: 50_000, activeWorkflows: null, executionsPerMonth: 200_000 },
    adds: ['Up to 10 client workspaces', 'Client report'],
  },
};

export function planFor(code: string): Plan {
  return PLANS[(PLAN_CODES as readonly string[]).includes(code) ? (code as PlanCode) : 'free'];
}

export type LimitCheck = { ok: true } | { ok: false; limit: LimitName; max: number };

/** Whether `adding` more of something fits under the plan limit, given what is already `used`. */
export function checkLimit(
  planCode: string,
  limit: LimitName,
  used: number,
  adding = 1,
): LimitCheck {
  const max = planFor(planCode).limits[limit];
  if (max === null || used + adding <= max) return { ok: true };
  return { ok: false, limit, max };
}

/** A seat is a member or a pending invitation, so an invite can never overbook the plan. */
export function checkSeats(planCode: string, members: number, pendingInvitations: number) {
  return checkLimit(planCode, 'users', members + pendingInvitations);
}
