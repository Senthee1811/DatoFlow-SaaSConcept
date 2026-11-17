import type { LeadSource, Priority } from './leads.js';

/**
 * The sample workspace (ORG-04): a fictional agency's pipeline, with 60 leads and 3 reps.
 * Deterministic, so every new workspace sees the same story and tests can rely on it.
 * Every record created from it carries isSample = true.
 */

export const SAMPLE_AGENCY = 'Kandy Bay Digital';

export interface SampleRep {
  name: string;
  /** Local part only. The API adds a per-organization suffix and an unroutable domain. */
  emailLocal: string;
}

export interface SampleLead {
  name: string;
  company: string;
  email: string;
  phone: string;
  source: LeadSource;
  /** Index into the default pipeline: 0 to 3 are open, 4 is Won, 5 is Lost. */
  stageIndex: number;
  /** Index into `reps`, or null for the unassigned pool. */
  ownerIndex: number | null;
  priority: Priority;
  dealValue: number | null;
  /** Index into the default loss reasons, for Lost leads. */
  lossReasonIndex: number | null;
  createdHoursAgo: number;
  lastActivityHoursAgo: number;
  notes: string | null;
  utm: { source?: string; medium?: string; campaign?: string } | null;
  timeline: { hoursAgo: number; text: string }[];
}

export interface SampleWorkspace {
  reps: SampleRep[];
  leads: SampleLead[];
}

export const SAMPLE_REPS: SampleRep[] = [
  { name: 'Nadeesha Fernando', emailLocal: 'nadeesha' },
  { name: 'Tharindu Jayasinghe', emailLocal: 'tharindu' },
  { name: 'Ishara Wickramasinghe', emailLocal: 'ishara' },
];

const FIRST = [
  'Amaya',
  'Ruwan',
  'Dilini',
  'Kasun',
  'Sachini',
  'Pradeep',
  'Hiruni',
  'Chamara',
  'Malsha',
  'Dinesh',
  'Anjali',
  'Ravindu',
  'Tharushi',
  'Lahiru',
  'Nethmi',
  'Sanjeewa',
  'Imesha',
  'Gayan',
  'Kavindi',
  'Mahesh',
  'Priya',
  'Arjun',
  'Fathima',
  'Rizwan',
  'Sarah',
  'Daniel',
  'Meera',
  'Oliver',
  'Aisha',
  'Tom',
];
const LAST = [
  'Perera',
  'Silva',
  'Fernando',
  'de Alwis',
  'Bandara',
  'Gunawardena',
  'Rathnayake',
  'Herath',
  'Dissanayake',
  'Senanayake',
  'Kumar',
  'Nair',
  'Hussain',
  'Rahman',
  'Collins',
  'Walker',
  'Iyer',
  'Ahmed',
  'Brooks',
  'Wijesekara',
];
const COMPANIES = [
  'Ceylon Spice Exports',
  'Galle Fort Boutique Hotel',
  'Lotus Dental Care',
  'Colombo Coworking Hub',
  'Highland Tea Estates',
  'Serendib Solar',
  'Marine Drive Motors',
  'Bluewave Swim School',
  'Ella Trails Tours',
  'Kingsbury Law Partners',
  'Urban Leaf Cafe',
  'Southern Coast Realty',
  'Nuwara Wellness Spa',
  'Pettah Wholesale Textiles',
  'Kelani Logistics',
  'Orchid Wedding Studio',
  'Bright Minds Tutoring',
  'Harbour View Apartments',
  'Coral Reef Diving',
  'Mount Lavinia Physio',
  'Green Grocer Delivery',
  'Sigiri Adventure Camps',
  'Lakeside Pet Clinic',
  'Royal Bakery',
  'Sapphire Jewellers',
  'Northgate Accounting',
  'Palm Grove Resort',
  'City Fitness Club',
  'Little Steps Preschool',
  'Kandyan Furniture Works',
];
const SOURCES: LeadSource[] = [
  'PAID_SOCIAL',
  'PAID_SEARCH',
  'FORM',
  'WEBSITE',
  'REFERRAL',
  'EVENT',
  'EMAIL',
];
const CAMPAIGNS = ['avurudu-offer', 'q4-leads', 'retargeting', 'free-consult', 'brand-search'];
const NOTES = [
  'Asked for pricing on the monthly retainer',
  'Wants to start before the holiday season',
  'Prefers WhatsApp over calls',
  'Budget approval needed from the owner',
  'Comparing us with two other agencies',
  'Interested in Google Ads only for now',
  "Came back after last year's campaign",
  'Needs a proposal in Sinhala and English',
];

/** Mulberry32: a tiny seeded generator, so the sample is the same every time. */
function random(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// 14 New, 14 Contacted, 10 Qualified, 8 Proposal, 8 Won, 6 Lost = 60.
const STAGE_COUNTS = [14, 14, 10, 8, 8, 6];

/**
 * Rough US dollar rates, so sample deal values read plausibly in the workspace currency.
 * Only for fictional sample data; nothing else uses them.
 */
const SAMPLE_RATE: Record<string, number> = {
  LKR: 300,
  INR: 85,
  PKR: 280,
  BDT: 120,
  AUD: 1.5,
  SGD: 1.35,
  AED: 3.7,
  EUR: 0.95,
  GBP: 0.8,
  CAD: 1.4,
};

export function sampleDealValue(usd: number | null, currency: string): number | null {
  if (usd === null) return null;
  const rate = SAMPLE_RATE[currency] ?? 1;
  // Round to two significant-looking figures, like a real quote.
  const value = usd * rate;
  const step = value >= 100_000 ? 5_000 : value >= 10_000 ? 500 : 50;
  return Math.max(step, Math.round(value / step) * step);
}

export function buildSampleWorkspace(seed = 20261116): SampleWorkspace {
  const rnd = random(seed);
  const pick = <T>(items: readonly T[]) => items[Math.floor(rnd() * items.length)]!;
  const leads: SampleLead[] = [];
  let n = 0;
  STAGE_COUNTS.forEach((count, stageIndex) => {
    for (let i = 0; i < count; i++, n++) {
      const first = FIRST[n % FIRST.length]!;
      const last = LAST[(n * 7) % LAST.length]!;
      const company = COMPANIES[n % COMPANIES.length]!;
      const createdHoursAgo = Math.round(6 + rnd() * 24 * 28);
      // About one in four open leads has gone quiet past the 72 h SLA, so the radar has something to show.
      const quiet = stageIndex < 4 && n % 4 === 1;
      const lastActivityHoursAgo = quiet
        ? Math.min(createdHoursAgo, Math.round(80 + rnd() * 120))
        : Math.round(Math.min(createdHoursAgo, rnd() * 60));
      const source = pick(SOURCES);
      const paid = source === 'PAID_SOCIAL' || source === 'PAID_SEARCH';
      leads.push({
        name: `${first} ${last}`,
        company,
        email:
          `${first}.${last}`.toLowerCase().replace(/[^a-z.]/g, '') +
          `@${company
            .toLowerCase()
            .replace(/[^a-z]/g, '')
            .slice(0, 14)}.lk`,
        phone: `+9477${String(1000000 + Math.floor(rnd() * 8999999)).padStart(7, '0')}`,
        source,
        stageIndex,
        // The first stage keeps a few unassigned leads in the pool.
        ownerIndex: stageIndex === 0 && i % 3 === 0 ? null : n % SAMPLE_REPS.length,
        priority: n % 6 === 0 ? 'HIGH' : n % 5 === 0 ? 'LOW' : 'NORMAL',
        // In US dollars; seeding scales it to the workspace currency.
        dealValue: stageIndex >= 2 ? Math.round(6 + rnd() * 54) * 100 : null,
        lossReasonIndex: stageIndex === 5 ? i % 5 : null,
        createdHoursAgo,
        lastActivityHoursAgo,
        notes: n % 3 === 0 ? pick(NOTES) : null,
        utm: paid
          ? {
              source: source === 'PAID_SOCIAL' ? 'facebook' : 'google',
              medium: 'cpc',
              campaign: pick(CAMPAIGNS),
            }
          : null,
        timeline: n % 2 === 0 ? [{ hoursAgo: lastActivityHoursAgo, text: pick(NOTES) }] : [],
      });
    }
  });
  // One deliberate repeat enquiry, so the duplicate marker has an example.
  const original = leads[3]!;
  leads[20] = {
    ...leads[20]!,
    name: original.name,
    email: original.email.toUpperCase(),
    company: original.company,
  };
  return { reps: SAMPLE_REPS, leads };
}

export interface SampleNextStep {
  leadIndex: number;
  title: string;
  type: 'CALL' | 'EMAIL' | 'WHATSAPP' | 'MEETING';
  dueAt: Date;
}

const STEP_BY_STAGE: { title: string; type: SampleNextStep['type'] }[] = [
  { title: 'First call to qualify', type: 'CALL' },
  { title: 'Send the case studies on WhatsApp', type: 'WHATSAPP' },
  { title: 'Discovery meeting', type: 'MEETING' },
  { title: 'Follow up on the proposal', type: 'EMAIL' },
];

/**
 * Next steps for the sample agency: one per open, assigned lead, except every seventh lead, which
 * has none. About one in five is overdue; the rest fall over the next three days.
 */
export function sampleNextSteps(leads: SampleLead[], now: Date): SampleNextStep[] {
  const HOUR = 3_600_000;
  return leads.flatMap((lead, i) => {
    if (lead.stageIndex > 3 || lead.ownerIndex === null || i % 7 === 3) return [];
    const overdue = i % 5 === 2;
    const hours = overdue ? -(2 + (i % 26)) : 1 + ((i * 5) % 71);
    return [
      {
        leadIndex: i,
        ...STEP_BY_STAGE[lead.stageIndex]!,
        dueAt: new Date(now.getTime() + hours * HOUR),
      },
    ];
  });
}
