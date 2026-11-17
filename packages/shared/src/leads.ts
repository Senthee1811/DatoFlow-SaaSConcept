import { z } from 'zod';
import { idParam } from './schemas.js';

export const LEAD_SOURCES = [
  'WEBSITE',
  'FORM',
  'WEBHOOK',
  'IMPORT',
  'REFERRAL',
  'PAID_SOCIAL',
  'PAID_SEARCH',
  'EMAIL',
  'EVENT',
  'MANUAL',
  'OTHER',
] as const;
export const PRIORITIES = ['LOW', 'NORMAL', 'HIGH'] as const;
export const STAGE_KINDS = ['OPEN', 'WON', 'LOST'] as const;

export type LeadSourceCode = (typeof LEAD_SOURCES)[number];
export type PriorityCode = (typeof PRIORITIES)[number];
export type StageKindCode = (typeof STAGE_KINDS)[number];

const optionalText = (max: number) => z.string().max(max).nullable().optional();

export const utmSchema = z
  .strictObject({
    source: z.string().max(200).optional(),
    medium: z.string().max(200).optional(),
    campaign: z.string().max(200).optional(),
    term: z.string().max(200).optional(),
    content: z.string().max(200).optional(),
  })
  .nullable();

const dealValue = z.number().nonnegative().max(1e12).multipleOf(0.01).nullable();

/** LEAD-01. Email and phone are normalised by the API (LEAD-02); invalid ones are field-level 422s. */
export const createLeadSchema = z.strictObject({
  name: z.string().trim().min(1, 'Enter a name').max(160),
  company: optionalText(160),
  email: optionalText(254),
  phone: optionalText(40),
  source: z.enum(LEAD_SOURCES).default('MANUAL'),
  stageId: idParam.optional(),
  ownerId: idParam.nullable().optional(),
  priority: z.enum(PRIORITIES).default('NORMAL'),
  dealValue: dealValue.optional(),
  notes: optionalText(5000),
  utm: utmSchema.optional(),
  lossReasonId: idParam.nullable().optional(),
});
export type CreateLeadInput = z.infer<typeof createLeadSchema>;

export const updateLeadSchema = z
  .strictObject({
    name: z.string().trim().min(1, 'Enter a name').max(160),
    company: optionalText(160),
    email: optionalText(254),
    phone: optionalText(40),
    source: z.enum(LEAD_SOURCES),
    stageId: idParam,
    ownerId: idParam.nullable(),
    priority: z.enum(PRIORITIES),
    dealValue,
    notes: optionalText(5000),
    utm: utmSchema,
    lossReasonId: idParam.nullable(),
  })
  .partial()
  .refine((v) => Object.keys(v).length > 0, 'Send at least one field');
export type UpdateLeadInput = z.infer<typeof updateLeadSchema>;

const csv = <T extends z.ZodType>(item: T) =>
  z
    .union([z.string(), z.array(z.string())])
    .transform((v) => (Array.isArray(v) ? v : v.split(',')).map((s) => s.trim()).filter(Boolean))
    .pipe(z.array(item).max(50) as unknown as z.ZodType<z.output<T>[], string[]>);

export const LEAD_SORTS = [
  'created_desc',
  'created_asc',
  'updated_desc',
  'sla_asc',
  'value_desc',
  'name_asc',
] as const;

/** LEAD-05 filters. Lists repeat as `?stage=a,b` or `?stage=a&stage=b`. */
export const leadListQuerySchema = z.strictObject({
  q: z.string().trim().max(120).optional(),
  owner: csv(z.union([idParam, z.enum(['me', 'none'])])).optional(),
  stage: csv(idParam).optional(),
  source: csv(z.enum(LEAD_SOURCES)).optional(),
  priority: csv(z.enum(PRIORITIES)).optional(),
  createdFrom: z.iso.date().optional(),
  createdTo: z.iso.date().optional(),
  stuck: z
    .enum(['true', 'false'])
    .transform((v) => v === 'true')
    .optional(),
  status: z.enum(['open', 'won', 'lost', 'all']).default('all'),
  archived: z
    .enum(['true', 'false'])
    .transform((v) => v === 'true')
    .default(false),
  sample: z.enum(['include', 'exclude', 'only']).default('include'),
  sort: z.enum(LEAD_SORTS).default('created_desc'),
  cursor: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});
export type LeadListQuery = z.infer<typeof leadListQuerySchema>;

/** Saved per user and organization, so filters persist (LEAD-05). */
export const leadFiltersSchema = z.strictObject({
  q: z.string().max(120).optional(),
  owner: z.array(z.string().max(64)).max(50).optional(),
  stage: z.array(z.string().max(64)).max(50).optional(),
  source: z.array(z.enum(LEAD_SOURCES)).max(20).optional(),
  priority: z.array(z.enum(PRIORITIES)).max(5).optional(),
  createdFrom: z.iso.date().optional(),
  createdTo: z.iso.date().optional(),
  stuck: z.boolean().optional(),
  status: z.enum(['open', 'won', 'lost', 'all']).optional(),
  archived: z.boolean().optional(),
  sort: z.enum(LEAD_SORTS).optional(),
});
export type LeadFilters = z.infer<typeof leadFiltersSchema>;

export const preferencesSchema = z.strictObject({
  leadFilters: leadFiltersSchema.optional(),
  leadView: z.enum(['table', 'board']).optional(),
  /** How reminders reach you (UF-8). In-app reminders are always on. Both default to on. */
  notifications: z
    .strictObject({
      reminderEmail: z.boolean().optional(),
      dailyDigest: z.boolean().optional(),
    })
    .optional(),
});
export type Preferences = z.infer<typeof preferencesSchema>;

export const createNoteSchema = z.strictObject({
  type: z.literal('NOTE'),
  text: z.string().trim().min(1, 'Write a note').max(5000),
});
export type CreateNoteInput = z.infer<typeof createNoteSchema>;

export const stageInputSchema = z.strictObject({
  id: idParam.optional(),
  name: z.string().trim().min(1, 'Name the stage').max(40),
  slaHours: z
    .number()
    .int()
    .min(1)
    .max(24 * 365),
  kind: z.enum(STAGE_KINDS),
});

export const updateStagesSchema = z.strictObject({
  stages: z.array(stageInputSchema).min(3).max(12),
});
export type UpdateStagesInput = z.infer<typeof updateStagesSchema>;

export const updatePipelineSchema = z.strictObject({ name: z.string().trim().min(1).max(60) });

export const lossReasonsSchema = z.strictObject({
  reasons: z
    .array(
      z.strictObject({
        id: idParam.optional(),
        label: z.string().trim().min(1).max(60),
        active: z.boolean().default(true),
      }),
    )
    .min(1)
    .max(30),
});
export type LossReasonsInput = z.infer<typeof lossReasonsSchema>;

// ---- Output DTOs ----

export interface StageDto {
  id: string;
  name: string;
  order: number;
  slaHours: number;
  kind: StageKindCode;
  leadCount: number;
}

export interface PipelineDto {
  id: string;
  name: string;
  stages: StageDto[];
}

export interface LossReasonDto {
  id: string;
  label: string;
  active: boolean;
}

export interface AssigneeDto {
  userId: string;
  name: string;
  role: string;
  isSample: boolean;
}

export interface LeadSummaryDto {
  id: string;
  name: string;
  company: string | null;
  email: string | null;
  phone: string | null;
  source: LeadSourceCode;
  stageId: string;
  ownerId: string | null;
  ownerName: string | null;
  priority: PriorityCode;
  dealValue: number | null;
  currency: string;
  isSample: boolean;
  stuck: boolean;
  /** Why it is stuck: no activity past the stage SLA, an overdue next step, or both. */
  stuckReasons: ('SLA' | 'NEXT_STEP_OVERDUE')[];
  /** When the radar flagged it. Null until the radar has seen it stuck. */
  stuckAt: string | null;
  slaDueAt: string | null;
  /** Due time of the earliest open next step, or null when it has none. */
  nextStepDueAt: string | null;
  lastActivityAt: string;
  archivedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface DuplicateDto {
  leadId: string;
  name: string;
  company: string | null;
  reason: 'EMAIL' | 'PHONE' | 'NAME_COMPANY';
}

export interface LeadDto extends LeadSummaryDto {
  emailNormalized: string | null;
  phoneE164: string | null;
  notes: string | null;
  utm: Record<string, string> | null;
  lossReasonId: string | null;
  stageEnteredAt: string;
  closedAt: string | null;
  duplicates: DuplicateDto[];
  canEdit: boolean;
}

export interface ActivityDto {
  id: string;
  type: string;
  actor: { type: 'USER' | 'WORKFLOW' | 'SYSTEM'; id: string | null; name: string };
  payload: Record<string, unknown>;
  occurredAt: string;
}
