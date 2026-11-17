import { describe, expect, it } from 'vitest';
import {
  ACTION_TYPES,
  checkDefinition,
  CONDITION_FIELDS,
  referencedStageIds,
  referencedUserIds,
  TRIGGERS,
  UNASSIGNED,
  type Action,
  type Condition,
  type Definition,
} from './catalogue.js';
import { conditionHolds, evaluateConditions, type ConditionSubject } from './conditions.js';
import {
  ActionError,
  admit,
  backoffMs,
  canRetryManually,
  canTransition,
  decideFailure,
  EXECUTION_STATUSES,
  isFinal,
  isRetryable,
  jobId,
  MAX_ATTEMPTS,
  MAX_DEPTH,
  monthStart,
  stepKey,
} from './execution.js';
import { applyTags, normaliseTags, pickRoundRobin, renderTemplate } from './helpers.js';

const notify: Action = { type: 'notify', to: 'owner', userId: null, message: 'New lead' };

function def(partial: Partial<Definition> = {}): Definition {
  return { trigger: 'lead.created', conditions: [], actions: [notify], ...partial };
}

describe('WF-01 builder rules', () => {
  it('WF-01: a definition has one trigger, AND-ed conditions and 1 to 10 actions', () => {
    expect(checkDefinition(def())).toEqual([]);
    expect(checkDefinition(def({ actions: [] }))).toEqual([
      { path: 'actions', message: 'Add at least one action' },
    ]);
    expect(checkDefinition(def({ actions: Array(10).fill(notify) }))).toEqual([]);
    expect(checkDefinition(def({ actions: Array(11).fill(notify) }))).toEqual([
      { path: 'actions', message: 'Use at most 10 actions' },
    ]);
    const many = Array(11).fill({ field: 'source', operator: 'is', values: ['FORM'] });
    expect(checkDefinition(def({ conditions: many }))[0]!.path).toBe('conditions');
  });
});

describe('WF-02 triggers', () => {
  it('WF-02: the catalogue has exactly the four triggers', () => {
    expect(TRIGGERS).toEqual([
      'lead.created',
      'lead.stage_changed',
      'lead.assigned',
      'task.deadline_reached',
    ]);
  });
});

describe('WF-03 conditions', () => {
  const subject: ConditionSubject = {
    source: 'WEBSITE',
    stage: 'stage-1',
    assignee: 'user-1',
    priority: 'HIGH',
  };

  it('WF-03: the catalogue has the four condition fields', () => {
    expect(CONDITION_FIELDS).toEqual(['source', 'stage', 'assignee', 'priority']);
  });

  it.each([
    ['source', 'WEBSITE', 'FORM'],
    ['stage', 'stage-1', 'stage-2'],
    ['assignee', 'user-1', 'user-2'],
    ['priority', 'HIGH', 'LOW'],
  ] as const)('WF-03: %s supports is, is any of and is none of', (field, match, other) => {
    expect(conditionHolds({ field, operator: 'is', values: [match] }, subject)).toBe(true);
    expect(conditionHolds({ field, operator: 'is', values: [other] }, subject)).toBe(false);
    expect(conditionHolds({ field, operator: 'is_any_of', values: [other, match] }, subject)).toBe(
      true,
    );
    expect(conditionHolds({ field, operator: 'is_any_of', values: [other] }, subject)).toBe(false);
    expect(conditionHolds({ field, operator: 'is_none_of', values: [other] }, subject)).toBe(true);
    expect(conditionHolds({ field, operator: 'is_none_of', values: [match] }, subject)).toBe(false);
  });

  it('WF-03: an unassigned lead matches the "unassigned" assignee value', () => {
    const pool = { ...subject, assignee: null };
    expect(conditionHolds({ field: 'assignee', operator: 'is', values: [UNASSIGNED] }, pool)).toBe(
      true,
    );
    expect(
      conditionHolds({ field: 'assignee', operator: 'is_none_of', values: [UNASSIGNED] }, subject),
    ).toBe(true);
  });

  it('WF-03: conditions are AND-ed and the first false one is reported', () => {
    expect(evaluateConditions([], subject)).toEqual({ ok: true });
    const yes: Condition = { field: 'source', operator: 'is', values: ['WEBSITE'] };
    const no: Condition = { field: 'priority', operator: 'is', values: ['LOW'] };
    expect(evaluateConditions([yes, yes], subject)).toEqual({ ok: true });
    expect(evaluateConditions([yes, no, no], subject)).toEqual({
      ok: false,
      index: 1,
      condition: no,
    });
  });

  it('WF-03: "is" takes one value, and values are not repeated', () => {
    const errors = checkDefinition(
      def({
        conditions: [
          { field: 'source', operator: 'is', values: ['FORM', 'WEBSITE'] },
          { field: 'source', operator: 'is_any_of', values: [] },
          { field: 'source', operator: 'is_none_of', values: ['FORM', 'FORM'] },
        ],
      }),
    );
    expect(errors.map((e) => e.path)).toEqual([
      'conditions.0.values',
      'conditions.1.values',
      'conditions.2.values',
    ]);
  });
});

describe('WF-04 actions', () => {
  it('WF-04: the catalogue has the five actions', () => {
    expect(ACTION_TYPES).toEqual(['assign', 'create_task', 'send_email', 'notify', 'update_field']);
  });

  it('WF-04: assign takes one member, or 2 to 25 for round-robin', () => {
    const check = (a: Action) => checkDefinition(def({ actions: [a] }));
    expect(check({ type: 'assign', mode: 'user', userIds: ['a'] })).toEqual([]);
    expect(check({ type: 'assign', mode: 'user', userIds: ['a', 'b'] })).toHaveLength(1);
    expect(check({ type: 'assign', mode: 'round_robin', userIds: ['a', 'b'] })).toEqual([]);
    expect(check({ type: 'assign', mode: 'round_robin', userIds: ['a'] })).toHaveLength(1);
    expect(check({ type: 'assign', mode: 'round_robin', userIds: ['a', 'a'] })).toEqual([
      { path: 'actions.0.userIds', message: 'Choose each member once' },
    ]);
    const many = Array.from({ length: 26 }, (_, i) => `u${i}`);
    expect(check({ type: 'assign', mode: 'round_robin', userIds: many })).toHaveLength(1);
  });

  it('WF-04: an email can be scheduled up to 30 days ahead, and no further', () => {
    const email = (delayMinutes: number): Action => ({
      type: 'send_email',
      to: 'lead',
      subject: 'Hi',
      body: 'Thanks',
      delayMinutes,
    });
    expect(checkDefinition(def({ actions: [email(30 * 24 * 60)] }))).toEqual([]);
    expect(checkDefinition(def({ actions: [email(30 * 24 * 60 + 1)] }))).toEqual([
      { path: 'actions.0.delayMinutes', message: 'Emails can be scheduled up to 30 days ahead' },
    ]);
    expect(checkDefinition(def({ actions: [email(-1)] }))).toHaveLength(1);
  });

  it('WF-04: a task is due within 30 days; notifying one member needs that member', () => {
    const task = (dueInHours: number): Action => ({
      type: 'create_task',
      title: 'Call',
      taskType: 'CALL',
      dueInHours,
      priority: 'NORMAL',
      assigneeId: null,
    });
    expect(checkDefinition(def({ actions: [task(720)] }))).toEqual([]);
    expect(checkDefinition(def({ actions: [task(721)] }))).toHaveLength(1);
    expect(
      checkDefinition(
        def({ actions: [{ type: 'notify', to: 'user', userId: null, message: 'x' }] }),
      ),
    ).toEqual([{ path: 'actions.0.userId', message: 'Choose who to notify' }]);
  });

  it('WF-04: only priority, stage, owner and tags can be updated', () => {
    const outside = { type: 'update_field', field: 'dealValue', value: 5 } as unknown as Action;
    expect(checkDefinition(def({ actions: [outside] }))).toEqual([
      {
        path: 'actions.0.field',
        message: 'Only priority, stage, owner and tags can be updated',
      },
    ]);
    const tags = (value: string[]): Action => ({
      type: 'update_field',
      field: 'tags',
      op: 'add',
      value,
    });
    expect(checkDefinition(def({ actions: [tags(['vip'])] }))).toEqual([]);
    expect(checkDefinition(def({ actions: [tags([])] }))).toHaveLength(1);
  });

  it('WF-04: the members and stages a definition refers to are listed for checking', () => {
    const d = def({
      conditions: [
        { field: 'assignee', operator: 'is_any_of', values: ['u1', UNASSIGNED] },
        { field: 'stage', operator: 'is', values: ['s1'] },
      ],
      actions: [
        { type: 'assign', mode: 'round_robin', userIds: ['u2', 'u3'] },
        {
          type: 'create_task',
          title: 'Call',
          taskType: 'CALL',
          dueInHours: 1,
          priority: 'HIGH',
          assigneeId: 'u4',
        },
        { type: 'notify', to: 'user', userId: 'u5', message: 'x' },
        { type: 'update_field', field: 'owner', value: 'u6' },
        { type: 'update_field', field: 'owner', value: null },
        { type: 'update_field', field: 'stage', value: 's2' },
        { type: 'update_field', field: 'priority', value: 'LOW' },
      ],
    });
    expect(referencedUserIds(d).sort()).toEqual(['u1', 'u2', 'u3', 'u4', 'u5', 'u6']);
    expect(referencedStageIds(d)).toEqual({ conditions: ['s1'], actions: ['s2'] });
  });

  it('WF-04: round-robin takes the next eligible member in turn', () => {
    const ids = ['a', 'b', 'c'];
    const all = () => true;
    expect(pickRoundRobin(ids, 0, all)).toEqual({ userId: 'a', cursor: 1 });
    expect(pickRoundRobin(ids, 1, all)).toEqual({ userId: 'b', cursor: 2 });
    expect(pickRoundRobin(ids, 3, all)).toEqual({ userId: 'a', cursor: 4 });
    // b left the workspace: c is next, and the turn after c goes back to a.
    expect(pickRoundRobin(ids, 1, (u) => u !== 'b')).toEqual({ userId: 'c', cursor: 3 });
    expect(pickRoundRobin(ids, 0, () => false)).toBeNull();
  });

  it('WF-04: templates fill known placeholders and leave others as typed', () => {
    expect(
      renderTemplate(
        'Hi {{lead.name}} from {{ org.name }}, {{owner.name}}{{lead.company}} {{x.y}}',
        {
          'lead.name': 'Amaya',
          'org.name': 'Northwind',
          'owner.name': null,
        },
      ),
    ).toBe('Hi Amaya from Northwind,  {{x.y}}');
  });

  it('WF-04: tags are normalised, added and removed', () => {
    expect(normaliseTags([' VIP', 'vip', '', 'Hot '])).toEqual(['vip', 'hot']);
    expect(applyTags(['vip'], 'add', ['Hot', 'VIP'])).toEqual(['vip', 'hot']);
    expect(applyTags(['vip', 'hot'], 'remove', ['HOT'])).toEqual(['vip']);
  });
});

describe('WF-06 state machine', () => {
  it('WF-06: the execution follows QUEUED → RUNNING → SUCCEEDED | FAILED → DEAD', () => {
    expect(canTransition('QUEUED', 'RUNNING')).toBe(true);
    expect(canTransition('RUNNING', 'SUCCEEDED')).toBe(true);
    expect(canTransition('RUNNING', 'FAILED')).toBe(true);
    expect(canTransition('FAILED', 'RUNNING')).toBe(true);
    expect(canTransition('RUNNING', 'DEAD')).toBe(true);
    expect(canTransition('QUEUED', 'CANCELLED')).toBe(true);
    expect(canTransition('FAILED', 'CANCELLED')).toBe(true);
    expect(canTransition('SUCCEEDED', 'RUNNING')).toBe(false);
    expect(canTransition('SKIPPED', 'QUEUED')).toBe(false);
    expect(canTransition('QUEUED', 'SUCCEEDED')).toBe(false);
    expect(canTransition('DEAD', 'RUNNING')).toBe(false);
    for (const s of EXECUTION_STATUSES) expect(canTransition(s, s)).toBe(false);
    expect(['SUCCEEDED', 'SKIPPED', 'CANCELLED'].every((s) => isFinal(s as never))).toBe(true);
    expect(isFinal('DEAD')).toBe(false);
  });

  it('WF-06: a manual retry is allowed only for FAILED or DEAD runs', () => {
    const allowed = EXECUTION_STATUSES.filter(canRetryManually);
    expect(allowed).toEqual(['FAILED', 'DEAD']);
    expect(allowed.every((s) => canTransition(s, 'QUEUED'))).toBe(true);
  });
});

describe('WF-07 idempotency keys', () => {
  it('WF-07: the same run and step always give the same side-effect key', () => {
    expect(stepKey('e1', 0)).toBe('wf:e1:0');
    expect(stepKey('e1', 0)).toBe(stepKey('e1', 0));
    expect(stepKey('e1', 1)).not.toBe(stepKey('e1', 0));
    expect(jobId.event('x')).toBe('event-x');
    expect(jobId.run('x', 0, 2)).toBe('run-x-0-2');
    // A manual retry starts a new round, so its jobs never collide with earlier ones.
    expect(jobId.run('x', 1, 2)).not.toBe(jobId.run('x', 0, 2));
  });
});

describe('WF-08 retries', () => {
  const now = new Date('2026-11-17T10:00:00Z');
  const backoff = { baseMs: 1000, capMs: 10_000 };

  it('WF-08: backoff doubles each attempt, with jitter between half and all of it, capped', () => {
    expect(backoffMs(1, backoff, () => 0)).toBe(500);
    expect(backoffMs(1, backoff, () => 1)).toBe(1000);
    expect(backoffMs(2, backoff, () => 0)).toBe(1000);
    expect(backoffMs(3, backoff, () => 0.5)).toBe(3000);
    expect(backoffMs(10, backoff, () => 1)).toBe(10_000);
    for (let i = 0; i < 50; i += 1) {
      const d = backoffMs(4, backoff);
      expect(d).toBeGreaterThanOrEqual(4000);
      expect(d).toBeLessThanOrEqual(8000);
    }
  });

  it('WF-08: a transient error is retried until the 5th attempt, then the run is DEAD', () => {
    const err = new Error('connection reset');
    for (let attempt = 1; attempt < MAX_ATTEMPTS; attempt += 1) {
      const d = decideFailure(attempt, err, now, backoff, () => 1);
      expect(d).toEqual({
        status: 'FAILED',
        retryAt: new Date(now.getTime() + Math.min(10_000, 1000 * 2 ** (attempt - 1))),
      });
    }
    expect(decideFailure(MAX_ATTEMPTS, err, now, backoff)).toEqual({
      status: 'DEAD',
      reason: 'ATTEMPTS_EXHAUSTED',
    });
    expect(MAX_ATTEMPTS).toBe(5);
  });

  it('WF-08: validation, permission and not-found errors fail fast', () => {
    for (const kind of ['VALIDATION', 'PERMISSION', 'NOT_FOUND'] as const) {
      const err = new ActionError(kind, 'no');
      expect(isRetryable(err)).toBe(false);
      expect(decideFailure(1, err, now)).toEqual({ status: 'DEAD', reason: 'NOT_RETRYABLE' });
    }
    expect(isRetryable(new ActionError('TRANSIENT', 'later'))).toBe(true);
    expect(isRetryable(new TypeError('x'))).toBe(true);
  });
});

describe('WF-09 loop protection', () => {
  const base = { depth: 0, selfTriggered: false, runsThisMonth: 0, monthlyCap: 500 };

  it('WF-09: events up to depth 3 run; deeper ones are skipped', () => {
    expect(MAX_DEPTH).toBe(3);
    expect(admit({ ...base, depth: 3 })).toEqual({ ok: true });
    expect(admit({ ...base, depth: 4 })).toEqual({ ok: false, reason: 'DEPTH_LIMIT' });
  });

  it('WF-09: a workflow never runs on an event its own run raised', () => {
    expect(admit({ ...base, depth: 1, selfTriggered: true })).toEqual({
      ok: false,
      reason: 'SELF_TRIGGER',
    });
  });

  it('WF-09: the monthly run cap of the plan is enforced; unlimited and sample runs are not capped', () => {
    expect(admit({ ...base, runsThisMonth: 499 })).toEqual({ ok: true });
    expect(admit({ ...base, runsThisMonth: 500 })).toEqual({ ok: false, reason: 'PLAN_LIMIT' });
    expect(admit({ ...base, runsThisMonth: 10_000, monthlyCap: null })).toEqual({ ok: true });
    expect(monthStart(new Date('2026-11-17T10:00:00Z'))).toEqual(new Date('2026-11-01T00:00:00Z'));
    expect(monthStart(new Date('2026-12-31T23:59:59Z'))).toEqual(new Date('2026-12-01T00:00:00Z'));
  });
});
