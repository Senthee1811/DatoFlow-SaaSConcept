import { describe, expect, it } from 'vitest';
import {
  actorName,
  buildSampleWorkspace,
  canEditLead,
  canSeeLead,
  cleanText,
  decideStageMove,
  diffFields,
  duplicateReason,
  isStuckBySla,
  leadScope,
  nameCompanyKey,
  normaliseContact,
  normaliseLeadEmail,
  normalisePhone,
  planStages,
  slaDueAt,
  type StageInput,
} from './index.js';

describe('normalisation', () => {
  it('LEAD-02: trims text and lower-cases email', () => {
    expect(cleanText('  Kandy   Bay  ')).toBe('Kandy Bay');
    expect(cleanText('   ')).toBeNull();
    expect(normaliseLeadEmail('  Amaya.Perera@Example.LK ')).toEqual({
      value: 'amaya.perera@example.lk',
    });
    expect(normaliseLeadEmail('')).toEqual({ value: null });
  });

  it('LEAD-02: an invalid email is an error', () => {
    expect(normaliseLeadEmail('amaya@')).toEqual({ error: 'Enter a valid email address' });
    expect(normaliseLeadEmail('two words@x.lk')).toHaveProperty('error');
  });

  it("LEAD-02: phones become E.164 using the organization's default country", () => {
    expect(normalisePhone('077 123 4567', 'LK')).toEqual({ value: '+94771234567' });
    expect(normalisePhone('+44 20 7946 0958', 'LK')).toEqual({ value: '+442079460958' });
    expect(normalisePhone('(415) 555-2671', 'us')).toEqual({ value: '+14155552671' });
    expect(normalisePhone('12', 'LK')).toEqual({ error: 'Enter a valid phone number' });
    expect(normalisePhone(null, 'LK')).toEqual({ value: null });
  });

  it('LEAD-02: field errors carry the field path', () => {
    expect(normaliseContact({ email: 'bad', phone: '1' }, 'LK')).toEqual({
      ok: false,
      errors: [
        { path: 'body.email', message: 'Enter a valid email address' },
        { path: 'body.phone', message: 'Enter a valid phone number' },
      ],
    });
    expect(normaliseContact({ email: 'A@B.co' }, 'LK')).toEqual({
      ok: true,
      value: { emailNormalized: 'a@b.co' },
    });
  });
});

describe('duplicates', () => {
  const base = { emailNormalized: null, phoneE164: null, nameCompanyKey: null };

  it('LEAD-03: matches on email, then phone, then name + company', () => {
    expect(
      duplicateReason(
        { ...base, emailNormalized: 'a@b.co' },
        { ...base, emailNormalized: 'a@b.co' },
      ),
    ).toBe('EMAIL');
    expect(
      duplicateReason(
        { ...base, phoneE164: '+94771234567' },
        { ...base, phoneE164: '+94771234567' },
      ),
    ).toBe('PHONE');
    const key = nameCompanyKey(' Amaya  Perera', 'Lotus Dental ');
    expect(key).toBe('amaya perera|lotus dental');
    expect(
      duplicateReason(
        { ...base, nameCompanyKey: key },
        { ...base, nameCompanyKey: nameCompanyKey('amaya perera', 'LOTUS DENTAL') },
      ),
    ).toBe('NAME_COMPANY');
  });

  it('LEAD-03: empty values never match, and a name without a company has no key', () => {
    expect(duplicateReason(base, base)).toBeNull();
    expect(nameCompanyKey('Amaya Perera', '')).toBeNull();
  });
});

describe('lead scope', () => {
  it('Sales Reps see their leads and the unassigned pool, unless the org setting is on', () => {
    const scope = leadScope('REP', 'u1', {});
    expect(scope).toEqual({ kind: 'own_and_pool', userId: 'u1' });
    expect(canSeeLead(scope, { ownerId: 'u1' })).toBe(true);
    expect(canSeeLead(scope, { ownerId: null })).toBe(true);
    expect(canSeeLead(scope, { ownerId: 'u2' })).toBe(false);
    expect(leadScope('REP', 'u1', { repsCanSeeAllLeads: true })).toEqual({ kind: 'all' });
    for (const role of ['OWNER', 'ADMIN', 'MANAGER'] as const)
      expect(leadScope(role, 'u1', {})).toEqual({ kind: 'all' });
  });

  it('Sales Reps edit only leads assigned to them', () => {
    expect(canEditLead('REP', 'u1', { ownerId: 'u1' })).toBe(true);
    expect(canEditLead('REP', 'u1', { ownerId: null })).toBe(false);
    expect(canEditLead('REP', 'u1', { ownerId: 'u2' })).toBe(false);
    expect(canEditLead('MANAGER', 'u1', { ownerId: 'u2' })).toBe(true);
  });
});

describe('stage moves', () => {
  it('PIPE-03: Lost needs a loss reason', () => {
    expect(
      decideStageMove({
        toKind: 'LOST',
        lossReasonId: null,
        dealValue: null,
        wonRequiresDealValue: true,
      }),
    ).toMatchObject({
      ok: false,
      code: 'LOSS_REASON_REQUIRED',
    });
    expect(
      decideStageMove({
        toKind: 'LOST',
        lossReasonId: 'r1',
        dealValue: null,
        wonRequiresDealValue: true,
      }),
    ).toEqual({ ok: true });
  });

  it('PIPE-03: Won needs a deal value when the org setting is on', () => {
    expect(
      decideStageMove({
        toKind: 'WON',
        lossReasonId: null,
        dealValue: null,
        wonRequiresDealValue: true,
      }),
    ).toMatchObject({
      ok: false,
      code: 'DEAL_VALUE_REQUIRED',
    });
    expect(
      decideStageMove({
        toKind: 'WON',
        lossReasonId: null,
        dealValue: 0,
        wonRequiresDealValue: true,
      }),
    ).toMatchObject({ ok: false });
    expect(
      decideStageMove({
        toKind: 'WON',
        lossReasonId: null,
        dealValue: 5000,
        wonRequiresDealValue: true,
      }),
    ).toEqual({ ok: true });
    expect(
      decideStageMove({
        toKind: 'WON',
        lossReasonId: null,
        dealValue: null,
        wonRequiresDealValue: false,
      }),
    ).toEqual({ ok: true });
    expect(
      decideStageMove({
        toKind: 'OPEN',
        lossReasonId: null,
        dealValue: null,
        wonRequiresDealValue: true,
      }),
    ).toEqual({ ok: true });
  });
});

describe('stage configuration', () => {
  const current = [
    { id: 's1', kind: 'OPEN' as const, leadCount: 3 },
    { id: 's2', kind: 'OPEN' as const, leadCount: 0 },
    { id: 'won', kind: 'WON' as const, leadCount: 1 },
    { id: 'lost', kind: 'LOST' as const, leadCount: 0 },
  ];
  const keep: StageInput[] = [
    { id: 's1', name: 'New', slaHours: 24, kind: 'OPEN' },
    { id: 'won', name: 'Won', slaHours: 72, kind: 'WON' },
    { id: 'lost', name: 'Lost', slaHours: 72, kind: 'LOST' },
  ];

  it('PIPE-01: add, rename, reorder and drop an empty stage', () => {
    const next: StageInput[] = [{ name: 'Discovery', slaHours: 48, kind: 'OPEN' }, ...keep];
    expect(planStages(current, next)).toEqual({ ok: true, removed: ['s2'] });
  });

  it('PIPE-01: a stage that holds leads cannot be deleted until they are moved', () => {
    const next = keep
      .filter((s) => s.id !== 's1')
      .concat({ name: 'Fresh', slaHours: 72, kind: 'OPEN' });
    expect(planStages(current, next)).toEqual({
      ok: false,
      code: 'STAGE_NOT_EMPTY',
      stageIds: ['s1'],
    });
  });

  it('PIPE-01: a stage with leads cannot switch between open and closed', () => {
    const next = keep.map((s) => (s.id === 'won' ? { ...s, kind: 'OPEN' as const } : s));
    next.push({ name: 'Closed won', slaHours: 72, kind: 'WON' });
    expect(planStages(current, next)).toMatchObject({
      ok: false,
      code: 'STAGE_NOT_EMPTY',
      stageIds: ['won'],
    });
  });

  it('PIPE-01: needs one open stage, exactly one Won and one Lost, unique names and known ids', () => {
    const bad = planStages(current, [
      { name: 'Won', slaHours: 72, kind: 'WON' },
      { name: 'won', slaHours: 72, kind: 'WON' },
      { id: 'nope', name: 'X', slaHours: 72, kind: 'LOST' },
    ]);
    expect(bad).toMatchObject({ ok: false, code: 'INVALID_STAGES' });
    const messages = bad.ok ? [] : 'errors' in bad ? bad.errors.map((e) => e.message) : [];
    expect(messages).toEqual(
      expect.arrayContaining([
        'Keep at least one open stage',
        'Mark exactly one stage as Won',
        'Stage names must be different',
        'Unknown stage',
      ]),
    );
    const tooMany = Array.from({ length: 11 }, (_, i) => ({
      name: `S${i}`,
      slaHours: 72,
      kind: 'OPEN' as const,
    }));
    expect(planStages([], [...tooMany, ...keep.map(({ id: _id, ...s }) => s)])).toMatchObject({
      ok: false,
      code: 'INVALID_STAGES',
    });
  });
});

describe('SLA', () => {
  const at = new Date('2026-11-16T00:00:00Z');

  it('TASK-03 groundwork: an open lead is due its stage SLA after its last activity', () => {
    expect(slaDueAt(at, 72, 'OPEN')?.toISOString()).toBe('2026-11-19T00:00:00.000Z');
    expect(slaDueAt(at, 72, 'WON')).toBeNull();
  });

  it('a lead past its SLA is stuck, unless archived or closed', () => {
    const due = new Date('2026-11-19T00:00:00Z');
    expect(
      isStuckBySla({ slaDueAt: due, archivedAt: null }, new Date('2026-11-19T00:00:01Z')),
    ).toBe(true);
    expect(
      isStuckBySla({ slaDueAt: due, archivedAt: null }, new Date('2026-11-18T23:59:59Z')),
    ).toBe(false);
    expect(isStuckBySla({ slaDueAt: due, archivedAt: at }, new Date('2026-12-01T00:00:00Z'))).toBe(
      false,
    );
    expect(
      isStuckBySla({ slaDueAt: null, archivedAt: null }, new Date('2026-12-01T00:00:00Z')),
    ).toBe(false);
  });
});

describe('timeline', () => {
  it('LEAD-06: workflow changes show the actor as "Workflow: name"', () => {
    expect(actorName({ type: 'WORKFLOW', label: 'Assign new leads' })).toBe(
      'Workflow: Assign new leads',
    );
    expect(actorName({ type: 'USER', label: 'Ruwani Perera' })).toBe('Ruwani Perera');
    expect(actorName({ type: 'SYSTEM', label: null })).toBe('DatoFlow');
    expect(actorName({ type: 'USER', label: null })).toBe('Former member');
  });

  it('LEAD-06: only changed fields are logged', () => {
    expect(
      diffFields(
        { name: 'A', company: 'X', dealValue: 100 },
        { name: 'A', company: 'Y', dealValue: 100 },
      ),
    ).toEqual([{ field: 'company', from: 'X', to: 'Y' }]);
    expect(diffFields({ notes: null }, { notes: undefined })).toEqual([]);
  });
});

describe('sample workspace', () => {
  const sample = buildSampleWorkspace();

  it('ORG-04: a fictional agency with 60 leads and 3 reps', () => {
    expect(sample.leads).toHaveLength(60);
    expect(sample.reps).toHaveLength(3);
    expect(new Set(sample.leads.map((l) => l.stageIndex))).toEqual(new Set([0, 1, 2, 3, 4, 5]));
  });

  it('ORG-04: the sample data is complete and consistent', () => {
    for (const lead of sample.leads) {
      expect(normaliseLeadEmail(lead.email)).not.toHaveProperty('error');
      expect(normalisePhone(lead.phone, 'LK')).not.toHaveProperty('error');
      expect(lead.lastActivityHoursAgo).toBeLessThanOrEqual(lead.createdHoursAgo);
      if (lead.stageIndex === 5) expect(lead.lossReasonIndex).not.toBeNull();
      if (lead.stageIndex === 4) expect(lead.dealValue).toBeGreaterThan(0);
      if (lead.ownerIndex !== null) expect(lead.ownerIndex).toBeLessThan(3);
    }
    expect(sample.leads.some((l) => l.ownerIndex === null)).toBe(true);
    expect(sample.leads.some((l) => l.stageIndex < 4 && l.lastActivityHoursAgo > 72)).toBe(true);
  });

  it('is the same every time', () => {
    expect(buildSampleWorkspace()).toEqual(sample);
  });
});

describe('organization days', () => {
  it('LEAD-05: date filters use the organization timezone', async () => {
    const { startOfDayInZone, endOfDayInZone } = await import('./index.js');
    expect(startOfDayInZone('2026-11-16', 'Asia/Colombo').toISOString()).toBe(
      '2026-11-15T18:30:00.000Z',
    );
    expect(endOfDayInZone('2026-11-16', 'Asia/Colombo').toISOString()).toBe(
      '2026-11-16T18:30:00.000Z',
    );
    expect(startOfDayInZone('2026-11-16', 'UTC').toISOString()).toBe('2026-11-16T00:00:00.000Z');
    // New York changes from EDT to EST on 2026-11-01.
    expect(startOfDayInZone('2026-11-01', 'America/New_York').toISOString()).toBe(
      '2026-11-01T04:00:00.000Z',
    );
    expect(startOfDayInZone('2026-11-02', 'America/New_York').toISOString()).toBe(
      '2026-11-02T05:00:00.000Z',
    );
  });
});

describe('sample deal values', () => {
  it('ORG-04: sample deal values read plausibly in the workspace currency', async () => {
    const { sampleDealValue } = await import('./index.js');
    expect(sampleDealValue(null, 'USD')).toBeNull();
    expect(sampleDealValue(2400, 'USD')).toBe(2400);
    expect(sampleDealValue(2400, 'LKR')).toBe(720000);
    expect(sampleDealValue(2400, 'XYZ')).toBe(2400);
  });
});
