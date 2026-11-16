import { describe, expect, it } from 'vitest';
import {
  CAPABILITIES,
  DEFAULT_PIPELINE,
  PLANS,
  ROLES,
  ROLE_LABEL,
  accessFor,
  can,
  canGrantRole,
  checkLimit,
  checkSeats,
  decideMemberChange,
  invitationExpiry,
  invitationProblem,
  planFor,
  type Access,
  type Capability,
} from './index.js';

// The table from section 6, written out again by hand so a typo in roles.ts cannot hide.
// Columns: OWNER, ADMIN, MANAGER, REP.
const EXPECTED: Record<Capability, [Access, Access, Access, Access]> = {
  'billing.manage': ['all', 'none', 'none', 'none'],
  'org.settings': ['all', 'all', 'none', 'none'],
  'members.manage': ['all', 'not_owner', 'none', 'none'],
  'integrations.manage': ['all', 'all', 'none', 'none'],
  'workflows.manage': ['all', 'all', 'all', 'none'],
  'leads.view': ['all', 'all', 'all', 'assigned_and_pool'],
  'leads.edit': ['all', 'all', 'all', 'assigned'],
  'leads.reassign': ['all', 'all', 'all', 'none'],
  'csv.import_export': ['all', 'all', 'all', 'none'],
  'leads.archive': ['all', 'all', 'all', 'none'],
  'analytics.team': ['all', 'all', 'all', 'own'],
  'audit.view': ['all', 'all', 'none', 'none'],
};

describe('role table', () => {
  for (const capability of CAPABILITIES) {
    ROLES.forEach((role, column) => {
      const expected = EXPECTED[capability][column]!;
      it(`${ROLE_LABEL[role]} / ${capability} = ${expected}`, () => {
        expect(accessFor(role, capability)).toBe(expected);
        expect(can(role, capability)).toBe(expected !== 'none');
      });
    });
  }

  it('covers every row of the table', () => {
    expect(Object.keys(EXPECTED).sort()).toEqual([...CAPABILITIES].sort());
  });
});

describe('members', () => {
  it('ORG-03: an Admin cannot grant Owner, an Owner can grant any role', () => {
    expect(canGrantRole('ADMIN', 'OWNER')).toBe(false);
    expect(canGrantRole('ADMIN', 'ADMIN')).toBe(true);
    expect(ROLES.every((r) => canGrantRole('OWNER', r))).toBe(true);
    expect(ROLES.some((r) => canGrantRole('MANAGER', r) || canGrantRole('REP', r))).toBe(false);
  });

  it('ORG-03: the last Owner cannot be removed or demoted', () => {
    const base = { actorRole: 'OWNER', currentRole: 'OWNER', ownerCount: 1 } as const;
    expect(decideMemberChange({ ...base, nextRole: null })).toEqual({
      ok: false,
      reason: 'LAST_OWNER',
    });
    expect(decideMemberChange({ ...base, nextRole: 'ADMIN' })).toEqual({
      ok: false,
      reason: 'LAST_OWNER',
    });
    expect(decideMemberChange({ ...base, nextRole: 'OWNER' })).toEqual({ ok: true });
    expect(decideMemberChange({ ...base, ownerCount: 2, nextRole: 'ADMIN' })).toEqual({ ok: true });
  });

  it('ORG-03: an Admin cannot change or remove an Owner', () => {
    const r = decideMemberChange({
      actorRole: 'ADMIN',
      currentRole: 'OWNER',
      nextRole: 'REP',
      ownerCount: 2,
    });
    expect(r).toEqual({ ok: false, reason: 'FORBIDDEN' });
    expect(
      decideMemberChange({
        actorRole: 'ADMIN',
        currentRole: 'REP',
        nextRole: 'OWNER',
        ownerCount: 1,
      }),
    ).toEqual({ ok: false, reason: 'FORBIDDEN' });
    expect(
      decideMemberChange({ actorRole: 'ADMIN', currentRole: 'REP', nextRole: null, ownerCount: 1 }),
    ).toEqual({ ok: true });
    expect(
      decideMemberChange({ actorRole: 'REP', currentRole: 'REP', nextRole: null, ownerCount: 1 }),
    ).toEqual({ ok: false, reason: 'FORBIDDEN' });
  });
});

describe('plans', () => {
  it('BILL-01: plan limits match the plan table', () => {
    expect(PLANS.free.limits).toEqual({
      users: 2,
      leads: 250,
      activeWorkflows: 1,
      executionsPerMonth: 500,
    });
    expect(PLANS.starter.limits.users).toBe(5);
    expect(PLANS.growth.limits.leads).toBe(15_000);
    expect(PLANS.agency.limits.activeWorkflows).toBeNull();
    expect(
      [PLANS.free, PLANS.starter, PLANS.growth, PLANS.agency].map((p) => p.usdPerMonth),
    ).toEqual([0, 19, 49, 99]);
  });

  it('names the limit that was hit', () => {
    expect(checkLimit('free', 'users', 2)).toEqual({ ok: false, limit: 'users', max: 2 });
    expect(checkLimit('free', 'users', 1)).toEqual({ ok: true });
    expect(checkLimit('agency', 'activeWorkflows', 10_000)).toEqual({ ok: true });
  });

  it('counts pending invitations as seats', () => {
    expect(checkSeats('free', 1, 0)).toEqual({ ok: true });
    expect(checkSeats('free', 1, 1)).toEqual({ ok: false, limit: 'users', max: 2 });
  });

  it('falls back to Free for an unknown plan code', () => {
    expect(planFor('enterprise').code).toBe('free');
  });
});

describe('invitations', () => {
  const now = new Date('2026-11-16T00:00:00Z');
  const inv = {
    status: 'PENDING',
    expiresAt: invitationExpiry(now),
    email: 'Rep@Agency.co',
  } as const;

  it('ORG-03: expires after 7 days', () => {
    expect(inv.expiresAt.toISOString()).toBe('2026-11-23T00:00:00.000Z');
    expect(invitationProblem(inv, 'rep@agency.co', new Date('2026-11-22T23:59:59Z'))).toBeNull();
    expect(invitationProblem(inv, 'rep@agency.co', new Date('2026-11-23T00:00:00Z'))).toBe(
      'EXPIRED',
    );
  });

  it('ORG-03: is single-use and must match the invitee email', () => {
    expect(invitationProblem({ ...inv, status: 'ACCEPTED' }, 'rep@agency.co', now)).toBe('USED');
    expect(invitationProblem({ ...inv, status: 'REVOKED' }, 'rep@agency.co', now)).toBe('REVOKED');
    expect(invitationProblem({ ...inv, status: 'EXPIRED' }, 'rep@agency.co', now)).toBe('EXPIRED');
    expect(invitationProblem(inv, 'someone@else.co', now)).toBe('EMAIL_MISMATCH');
    expect(invitationProblem(inv, ' REP@agency.co ', now)).toBeNull();
    expect(invitationProblem(inv, null, now)).toBeNull();
  });
});

describe('default pipeline', () => {
  it('ORG-01: has 4 open stages, Won and Lost, each with a 72 h SLA', () => {
    const kinds = DEFAULT_PIPELINE.stages.map((s) => s.kind);
    expect(kinds).toEqual(['OPEN', 'OPEN', 'OPEN', 'OPEN', 'WON', 'LOST']);
    expect(DEFAULT_PIPELINE.stages.map((s) => s.order)).toEqual([0, 1, 2, 3, 4, 5]);
    expect(DEFAULT_PIPELINE.stages.every((s) => s.slaHours === 72)).toBe(true);
  });
});
