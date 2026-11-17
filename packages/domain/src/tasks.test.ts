import { describe, expect, it } from 'vitest';
import { hasFeature } from './plans.js';
import { buildSampleWorkspace, sampleNextSteps } from './sample.js';
import {
  decideTouch,
  digestDue,
  digestKey,
  emailBudget,
  emailBudgetDay,
  emailOrder,
  endOfToday,
  isNextStep,
  isOverdue,
  isStuck,
  localDate,
  localHour,
  missedSince,
  nextStepDueAt,
  orderStuck,
  planDay,
  reminderDue,
  reminderHorizon,
  reminderKey,
  stuckReasons,
  type RadarLead,
} from './tasks.js';

const at = (iso: string) => new Date(iso);
const now = at('2026-11-17T06:00:00Z'); // 11:30 in Colombo
const H = 3_600_000;
const hoursFrom = (h: number) => new Date(now.getTime() + h * H);

describe('TASK-01: tasks and next steps', () => {
  it('TASK-01: a next step is an open task with an assignee', () => {
    expect(isNextStep({ status: 'OPEN', dueAt: now, assigneeId: 'u1' })).toBe(true);
    expect(isNextStep({ status: 'OPEN', dueAt: now, assigneeId: null })).toBe(false);
    expect(isNextStep({ status: 'DONE', dueAt: now, assigneeId: 'u1' })).toBe(false);
    expect(isNextStep({ status: 'CANCELLED', dueAt: now, assigneeId: 'u1' })).toBe(false);
  });

  it("TASK-01: a lead's next step is its earliest open one, and closed leads have none", () => {
    const tasks = [
      { status: 'OPEN' as const, dueAt: hoursFrom(5), assigneeId: 'u1' },
      { status: 'OPEN' as const, dueAt: hoursFrom(2), assigneeId: 'u1' },
      { status: 'DONE' as const, dueAt: hoursFrom(-9), assigneeId: 'u1' },
      { status: 'OPEN' as const, dueAt: hoursFrom(-20), assigneeId: null },
    ];
    expect(nextStepDueAt({ kind: 'OPEN', archivedAt: null }, tasks)).toEqual(hoursFrom(2));
    expect(nextStepDueAt({ kind: 'OPEN', archivedAt: null }, [])).toBeNull();
    expect(nextStepDueAt({ kind: 'WON', archivedAt: null }, tasks)).toBeNull();
    expect(nextStepDueAt({ kind: 'LOST', archivedAt: null }, tasks)).toBeNull();
    expect(nextStepDueAt({ kind: 'OPEN', archivedAt: now }, tasks)).toBeNull();
  });
});

describe('TASK-02: the next-step rule', () => {
  it('TASK-02: a touch on an open lead without a new next step is refused', () => {
    expect(decideTouch({ kindAfter: 'OPEN', hasNewNextStep: false, rule: 'require' })).toEqual({
      ok: false,
      code: 'NEXT_STEP_REQUIRED',
      path: 'body.nextStep',
      message: 'Set the next step, or mark the lead as Won or Lost',
    });
  });

  it('TASK-02: a touch with a new next step is accepted', () => {
    expect(decideTouch({ kindAfter: 'OPEN', hasNewNextStep: true, rule: 'require' })).toEqual({
      ok: true,
      warning: null,
    });
  });

  it('TASK-02: a touch that moves the lead to Won or Lost needs no next step', () => {
    for (const kindAfter of ['WON', 'LOST'] as const) {
      expect(decideTouch({ kindAfter, hasNewNextStep: false, rule: 'require' }).ok).toBe(true);
    }
  });

  it('TASK-02: an organization on "warn only" saves the touch with a warning', () => {
    expect(decideTouch({ kindAfter: 'OPEN', hasNewNextStep: false, rule: 'warn' })).toEqual({
      ok: true,
      warning: 'NEXT_STEP_MISSING',
    });
    expect(decideTouch({ kindAfter: 'OPEN', hasNewNextStep: true, rule: 'warn' }).ok).toBe(true);
  });
});

describe('TASK-03: overdue markers and the stuck-lead radar', () => {
  const lead = (over: Partial<RadarLead>): RadarLead => ({
    kind: 'OPEN',
    archivedAt: null,
    slaDueAt: hoursFrom(10),
    nextStepDueAt: hoursFrom(3),
    ...over,
  });

  it('TASK-03: an open task past its due time is overdue; a finished one never is', () => {
    expect(isOverdue({ status: 'OPEN', dueAt: hoursFrom(-1) }, now)).toBe(true);
    expect(isOverdue({ status: 'OPEN', dueAt: hoursFrom(1) }, now)).toBe(false);
    expect(isOverdue({ status: 'DONE', dueAt: hoursFrom(-1) }, now)).toBe(false);
    expect(isOverdue({ status: 'CANCELLED', dueAt: hoursFrom(-1) }, now)).toBe(false);
  });

  it('TASK-03: a lead is stuck past its stage SLA, with an overdue next step, or both', () => {
    expect(stuckReasons(lead({}), now)).toEqual([]);
    expect(stuckReasons(lead({ slaDueAt: hoursFrom(-1) }), now)).toEqual(['SLA']);
    expect(stuckReasons(lead({ nextStepDueAt: hoursFrom(-1) }), now)).toEqual([
      'NEXT_STEP_OVERDUE',
    ]);
    expect(
      stuckReasons(lead({ slaDueAt: hoursFrom(-2), nextStepDueAt: hoursFrom(-1) }), now),
    ).toEqual(['SLA', 'NEXT_STEP_OVERDUE']);
    expect(isStuck(lead({ slaDueAt: null, nextStepDueAt: null }), now)).toBe(false);
  });

  it('TASK-03: closed and archived leads are never stuck', () => {
    const late = { slaDueAt: hoursFrom(-5), nextStepDueAt: hoursFrom(-5) };
    expect(isStuck(lead({ ...late, kind: 'WON' }), now)).toBe(false);
    expect(isStuck(lead({ ...late, kind: 'LOST' }), now)).toBe(false);
    expect(isStuck(lead({ ...late, archivedAt: now }), now)).toBe(false);
    expect(missedSince(lead({ ...late, kind: 'WON' }), now)).toBeNull();
  });

  it('TASK-03: a stuck lead is stuck since its first missed deadline', () => {
    expect(
      missedSince(lead({ slaDueAt: hoursFrom(-2), nextStepDueAt: hoursFrom(-7) }), now),
    ).toEqual(hoursFrom(-7));
    expect(
      missedSince(lead({ slaDueAt: hoursFrom(-2), nextStepDueAt: hoursFrom(1) }), now),
    ).toEqual(hoursFrom(-2));
    expect(missedSince(lead({}), now)).toBeNull();
  });
});

describe('TASK-05: My day', () => {
  const task = (id: string, dueAt: Date, priority: 'LOW' | 'NORMAL' | 'HIGH' = 'NORMAL') => ({
    id,
    dueAt,
    priority,
  });

  it('TASK-05: overdue next steps come first, then those due today; later ones wait', () => {
    // 06:00Z is 11:30 in Colombo; the Colombo day ends at 18:30Z.
    const tasks = [
      task('tomorrow', at('2026-11-17T19:00:00Z')),
      task('tonight', at('2026-11-17T18:00:00Z')),
      task('soon', hoursFrom(1)),
      task('late-high', hoursFrom(-3), 'HIGH'),
      task('late-low', hoursFrom(-3), 'LOW'),
      task('yesterday', hoursFrom(-30)),
    ];
    const day = planDay(tasks, now, 'Asia/Colombo');
    expect(day.overdue.map((t) => t.id)).toEqual(['yesterday', 'late-high', 'late-low']);
    expect(day.today.map((t) => t.id)).toEqual(['soon', 'tonight']);
  });

  it("TASK-05: today ends at midnight in the organization's timezone", () => {
    expect(endOfToday(now, 'Asia/Colombo')).toEqual(at('2026-11-17T18:30:00Z'));
    expect(endOfToday(now, 'America/New_York')).toEqual(at('2026-11-18T05:00:00Z'));
    expect(localDate(at('2026-11-17T20:00:00Z'), 'Asia/Colombo')).toBe('2026-11-18');
  });

  it('TASK-05: stuck leads are listed longest stuck first, and only stuck ones', () => {
    const leads = [
      {
        id: 'a',
        kind: 'OPEN' as const,
        archivedAt: null,
        slaDueAt: hoursFrom(-1),
        nextStepDueAt: null,
      },
      {
        id: 'b',
        kind: 'OPEN' as const,
        archivedAt: null,
        slaDueAt: hoursFrom(5),
        nextStepDueAt: hoursFrom(-9),
      },
      {
        id: 'c',
        kind: 'OPEN' as const,
        archivedAt: null,
        slaDueAt: hoursFrom(5),
        nextStepDueAt: null,
      },
    ];
    expect(orderStuck(leads, now).map((l) => l.id)).toEqual(['b', 'a']);
  });
});

describe('TASK-04: reminders and the daily digest', () => {
  const due = at('2026-11-17T06:10:00Z');

  it('TASK-04: the reminder key is the task, the type and the due time', () => {
    expect(reminderKey('t1', 'IN_APP', due)).toBe('reminder:t1:IN_APP:2026-11-17T06:10:00.000Z');
    expect(reminderKey('t1', 'EMAIL', due)).not.toBe(reminderKey('t1', 'IN_APP', due));
    // Moving the step to a new time earns a new reminder.
    expect(reminderKey('t1', 'IN_APP', at('2026-11-17T07:00:00Z'))).not.toBe(
      reminderKey('t1', 'IN_APP', due),
    );
  });

  it('TASK-04: a reminder is due in the 15 minutes before the step, not after', () => {
    expect(reminderDue(at('2026-11-17T06:15:00Z'), now)).toBe(true);
    expect(reminderDue(at('2026-11-17T06:16:00Z'), now)).toBe(false);
    expect(reminderDue(now, now)).toBe(false);
    expect(reminderDue(at('2026-11-17T05:59:00Z'), now)).toBe(false);
    expect(reminderHorizon(now)).toEqual(at('2026-11-17T06:15:00Z'));
  });

  it("TASK-04: the digest is due from 08:00 in the organization's timezone", () => {
    // 02:29Z is 07:59 in Colombo; 02:30Z is 08:00.
    expect(digestDue(at('2026-11-17T02:29:00Z'), 'Asia/Colombo')).toEqual({
      due: false,
      date: '2026-11-17',
    });
    expect(digestDue(at('2026-11-17T02:30:00Z'), 'Asia/Colombo').due).toBe(true);
    expect(digestDue(at('2026-11-17T18:29:00Z'), 'Asia/Colombo')).toEqual({
      due: true,
      date: '2026-11-17',
    });
    expect(digestDue(at('2026-11-17T18:30:00Z'), 'Asia/Colombo')).toEqual({
      due: false,
      date: '2026-11-18',
    });
  });

  it('TASK-04: the digest follows daylight saving', () => {
    // New York: 08:00 is 13:00Z in winter (EST) and 12:00Z in summer (EDT).
    expect(localHour(at('2026-01-15T13:00:00Z'), 'America/New_York')).toBe(8);
    expect(localHour(at('2026-07-15T12:00:00Z'), 'America/New_York')).toBe(8);
    expect(digestDue(at('2026-07-15T11:59:00Z'), 'America/New_York').due).toBe(false);
    expect(digestDue(at('2026-07-15T12:00:00Z'), 'America/New_York').due).toBe(true);
  });

  it('TASK-04: one digest per member, organization and day', () => {
    expect(digestKey('o1', 'u1', '2026-11-17')).toBe('digest:o1:u1:2026-11-17');
  });

  it('TASK-04: email reminders come with Starter and up, not Free', () => {
    expect(hasFeature('free', 'emailReminders')).toBe(false);
    expect(hasFeature('starter', 'emailReminders')).toBe(true);
    expect(hasFeature('growth', 'emailReminders')).toBe(true);
    expect(hasFeature('agency', 'emailReminders')).toBe(true);
    expect(hasFeature('unknown-plan', 'emailReminders')).toBe(false);
  });

  it('TASK-04: over the daily email limit, the rest wait for the next UTC day; digests go first', () => {
    expect(emailBudget(99, 100, now)).toEqual({ send: true });
    expect(emailBudget(100, 100, now)).toEqual({
      send: false,
      retryAt: at('2026-11-18T00:00:00Z'),
    });
    expect(emailBudgetDay(now)).toBe('2026-11-17');
    expect(emailOrder('DIGEST')).toBeLessThan(emailOrder('REMINDER'));
  });
});

describe('ORG-04: sample next steps', () => {
  it('ORG-04: open, assigned sample leads get next steps, some overdue, some without', () => {
    const sample = buildSampleWorkspace();
    const steps = sampleNextSteps(sample.leads, now);
    expect(steps.length).toBeGreaterThan(20);
    for (const s of steps) {
      const lead = sample.leads[s.leadIndex]!;
      expect(lead.stageIndex).toBeLessThan(4);
      expect(lead.ownerIndex).not.toBeNull();
    }
    expect(steps.some((s) => s.dueAt < now)).toBe(true);
    expect(steps.some((s) => s.dueAt > now)).toBe(true);
    const assignedOpen = sample.leads.filter((l) => l.stageIndex < 4 && l.ownerIndex !== null);
    expect(steps.length).toBeLessThan(assignedOpen.length);
  });
});

describe('TASK-01: due times in the organization timezone', () => {
  it('TASK-01: a due time typed in the organization timezone is stored as UTC and shown back', async () => {
    const { zonedDateTimeToUtc, utcToZonedInput } = await import('./time.js');
    expect(zonedDateTimeToUtc('2026-11-17T09:30', 'Asia/Colombo')).toEqual(
      new Date('2026-11-17T04:00:00Z'),
    );
    expect(zonedDateTimeToUtc('2026-07-15T08:00', 'America/New_York')).toEqual(
      new Date('2026-07-15T12:00:00Z'),
    );
    expect(zonedDateTimeToUtc('2026-01-15T08:00', 'America/New_York')).toEqual(
      new Date('2026-01-15T13:00:00Z'),
    );
    expect(utcToZonedInput(new Date('2026-11-17T04:00:30Z'), 'Asia/Colombo')).toBe(
      '2026-11-17T09:30',
    );
    expect(utcToZonedInput(new Date('2026-07-15T12:00:00Z'), 'America/New_York')).toBe(
      '2026-07-15T08:00',
    );
  });
});
