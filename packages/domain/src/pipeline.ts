export type StageKind = 'OPEN' | 'WON' | 'LOST';

/** Default stage SLA in hours. A lead with no activity for longer is stuck. */
export const DEFAULT_SLA_HOURS = 72;

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
