import { parsePhoneNumberFromString, type CountryCode } from 'libphonenumber-js/min';
import type { Role } from './roles.js';

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
export type LeadSource = (typeof LEAD_SOURCES)[number];

export const SOURCE_LABEL: Record<LeadSource, string> = {
  WEBSITE: 'Website',
  FORM: 'Capture form',
  WEBHOOK: 'Webhook',
  IMPORT: 'CSV import',
  REFERRAL: 'Referral',
  PAID_SOCIAL: 'Paid social',
  PAID_SEARCH: 'Paid search',
  EMAIL: 'Email',
  EVENT: 'Event',
  MANUAL: 'Added by hand',
  OTHER: 'Other',
};

export const PRIORITIES = ['LOW', 'NORMAL', 'HIGH'] as const;
export type Priority = (typeof PRIORITIES)[number];

export const PRIORITY_LABEL: Record<Priority, string> = {
  LOW: 'Low',
  NORMAL: 'Normal',
  HIGH: 'High',
};

export interface FieldError {
  path: string;
  message: string;
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Trims and collapses inner whitespace. Empty becomes null. */
export function cleanText(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const cleaned = value.trim().replace(/\s+/g, ' ');
  return cleaned === '' ? null : cleaned;
}

/** Lower-cased, trimmed email, or an error. Empty is allowed and becomes null (LEAD-02). */
export function normaliseLeadEmail(
  raw: string | null | undefined,
): { value: string | null } | { error: string } {
  const cleaned = cleanText(raw);
  if (cleaned === null) return { value: null };
  const lower = cleaned.toLowerCase();
  if (lower.length > 254 || !EMAIL.test(lower)) return { error: 'Enter a valid email address' };
  return { value: lower };
}

/**
 * E.164 phone number, read with the organization's default country when the number has no
 * country code (LEAD-02). Empty is allowed and becomes null.
 */
export function normalisePhone(
  raw: string | null | undefined,
  defaultCountry: string,
): { value: string | null } | { error: string } {
  const cleaned = cleanText(raw);
  if (cleaned === null) return { value: null };
  const parsed = parsePhoneNumberFromString(cleaned, defaultCountry.toUpperCase() as CountryCode);
  if (!parsed || !parsed.isValid()) return { error: 'Enter a valid phone number' };
  return { value: parsed.number };
}

export interface ContactInput {
  email?: string | null | undefined;
  phone?: string | null | undefined;
}

export interface NormalisedContact {
  emailNormalized: string | null;
  phoneE164: string | null;
}

/** Normalises the contact fields that were sent. Fields left out stay undefined. */
export function normaliseContact(
  input: ContactInput,
  defaultCountry: string,
): { ok: true; value: Partial<NormalisedContact> } | { ok: false; errors: FieldError[] } {
  const errors: FieldError[] = [];
  const value: Partial<NormalisedContact> = {};
  if (input.email !== undefined) {
    const email = normaliseLeadEmail(input.email);
    if ('error' in email) errors.push({ path: 'body.email', message: email.error });
    else value.emailNormalized = email.value;
  }
  if (input.phone !== undefined) {
    const phone = normalisePhone(input.phone, defaultCountry);
    if ('error' in phone) errors.push({ path: 'body.phone', message: phone.error });
    else value.phoneE164 = phone.value;
  }
  return errors.length ? { ok: false, errors } : { ok: true, value };
}

/**
 * The key for name + company duplicate matching: both lower-cased and whitespace-collapsed.
 * No company means no key, since a bare name matches too many people.
 */
export function nameCompanyKey(
  name: string | null | undefined,
  company: string | null | undefined,
): string | null {
  const n = cleanText(name)?.toLowerCase();
  const c = cleanText(company)?.toLowerCase();
  return n && c ? `${n}|${c}` : null;
}

export type DuplicateReason = 'EMAIL' | 'PHONE' | 'NAME_COMPANY';

export interface DuplicateKeys {
  emailNormalized: string | null;
  phoneE164: string | null;
  nameCompanyKey: string | null;
}

/** Why two leads look like the same person, strongest reason first. Never used to merge. */
export function duplicateReason(a: DuplicateKeys, b: DuplicateKeys): DuplicateReason | null {
  if (a.emailNormalized && a.emailNormalized === b.emailNormalized) return 'EMAIL';
  if (a.phoneE164 && a.phoneE164 === b.phoneE164) return 'PHONE';
  if (a.nameCompanyKey && a.nameCompanyKey === b.nameCompanyKey) return 'NAME_COMPANY';
  return null;
}

// ---------------------------------------------------------------------------
// Visibility and edit scope (role table, section 6)
// ---------------------------------------------------------------------------

export interface LeadAccessSettings {
  repsCanSeeAllLeads?: boolean | undefined;
}

/**
 * Which leads a member can see. Sales Reps see leads assigned to them plus the unassigned pool,
 * unless the organization turned on "Reps can see all leads".
 */
export type LeadScope = { kind: 'all' } | { kind: 'own_and_pool'; userId: string };

export function leadScope(role: Role, userId: string, settings: LeadAccessSettings): LeadScope {
  if (role !== 'REP' || settings.repsCanSeeAllLeads) return { kind: 'all' };
  return { kind: 'own_and_pool', userId };
}

export function canSeeLead(scope: LeadScope, lead: { ownerId: string | null }): boolean {
  return scope.kind === 'all' || lead.ownerId === null || lead.ownerId === scope.userId;
}

/** Sales Reps edit only leads assigned to them; everyone else edits any lead. */
export function canEditLead(role: Role, userId: string, lead: { ownerId: string | null }): boolean {
  return role !== 'REP' || lead.ownerId === userId;
}
