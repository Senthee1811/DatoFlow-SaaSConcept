import { z } from 'zod';

export const ROLES = ['OWNER', 'ADMIN', 'MANAGER', 'REP'] as const;
export const roleSchema = z.enum(ROLES);
export type Role = z.infer<typeof roleSchema>;

const timezones = new Set(Intl.supportedValuesOf('timeZone'));
timezones.add('UTC');
const currencies = new Set(Intl.supportedValuesOf('currency'));

export const DEFAULT_TIMEZONE = 'Asia/Colombo';
export const DEFAULT_CURRENCY = 'USD';

const name = z.string().trim().min(2).max(80);
const slug = z
  .string()
  .trim()
  .toLowerCase()
  .min(3)
  .max(40)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'Use lowercase letters, numbers and single hyphens');
const timezone = z.string().refine((v) => timezones.has(v), 'Unknown IANA timezone');
const currency = z
  .string()
  .trim()
  .toUpperCase()
  .refine((v) => currencies.has(v), 'Unknown ISO 4217 currency code');
const email = z.string().trim().toLowerCase().pipe(z.email().max(254));

export const idParam = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9_-]+$/);

export const createOrgSchema = z.strictObject({ name, slug, timezone, currency });
export type CreateOrgInput = z.infer<typeof createOrgSchema>;

export const orgSettingsSchema = z.strictObject({
  /** Role table footnote: off by default. */
  repsCanSeeAllLeads: z.boolean().optional(),
});
export type OrgSettings = z.infer<typeof orgSettingsSchema>;

export const updateOrgSchema = z
  .strictObject({ name, timezone, currency, settings: orgSettingsSchema })
  .partial()
  .refine((v) => Object.keys(v).length > 0, 'Send at least one field');
export type UpdateOrgInput = z.infer<typeof updateOrgSchema>;

export const createInvitationSchema = z.strictObject({ email, role: roleSchema });
export type CreateInvitationInput = z.infer<typeof createInvitationSchema>;

export const updateMemberSchema = z.strictObject({ role: roleSchema });
export type UpdateMemberInput = z.infer<typeof updateMemberSchema>;

export const pageQuerySchema = z.strictObject({
  cursor: idParam.optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});
export type PageQuery = z.infer<typeof pageQuerySchema>;

export const emptyQuerySchema = z.strictObject({});

/** 32 random bytes, base64url. */
export const invitationTokenParam = z.string().regex(/^[A-Za-z0-9_-]{43}$/);

export interface Page<T> {
  items: T[];
  nextCursor: string | null;
}

// ---- Output DTOs. Internal fields (token hashes, auth-provider columns) never appear here. ----

export interface OrgDto {
  id: string;
  name: string;
  slug: string;
  timezone: string;
  currency: string;
  planCode: string;
  settings: OrgSettings;
  role: Role;
  createdAt: string;
}

export interface MemberDto {
  id: string;
  userId: string;
  name: string;
  email: string;
  role: Role;
  joinedAt: string;
}

export type InvitationStatus = 'PENDING' | 'ACCEPTED' | 'REVOKED' | 'EXPIRED';

export interface InvitationDto {
  id: string;
  email: string;
  role: Role;
  status: InvitationStatus;
  expiresAt: string;
  invitedBy: string;
  createdAt: string;
}

export type InvitationProblem = 'EXPIRED' | 'USED' | 'REVOKED' | 'EMAIL_MISMATCH';

export interface InvitationPreviewDto {
  organizationName: string;
  organizationSlug: string;
  email: string;
  role: Role;
  /** Why the invitation cannot be accepted, or null when it can. */
  problem: InvitationProblem | null;
}

export interface AuditLogDto {
  id: string;
  action: string;
  actorId: string | null;
  actorName: string | null;
  targetType: string | null;
  targetId: string | null;
  metadata: Record<string, unknown>;
  ip: string | null;
  createdAt: string;
}
