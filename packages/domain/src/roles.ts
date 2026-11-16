/**
 * The role table from section 6 of the master prompt, encoded once.
 * The API enforces it on every request; the UI only hides what the API already forbids.
 */
export const ROLES = ['OWNER', 'ADMIN', 'MANAGER', 'REP'] as const;
export type Role = (typeof ROLES)[number];

export const ROLE_LABEL: Record<Role, string> = {
  OWNER: 'Owner',
  ADMIN: 'Admin',
  MANAGER: 'Sales Manager',
  REP: 'Sales Rep',
};

/**
 * What a role may do with a capability.
 * - `all`: without restriction
 * - `none`: not at all
 * - `not_owner`: members and roles, except anything that touches an Owner
 * - `assigned_and_pool`: leads assigned to the rep, plus unassigned leads
 * - `assigned`: only leads assigned to the rep
 * - `own`: only the rep's own metrics
 */
export type Access = 'all' | 'none' | 'not_owner' | 'assigned_and_pool' | 'assigned' | 'own';

export const CAPABILITIES = [
  'billing.manage',
  'org.settings',
  'members.manage',
  'integrations.manage',
  'workflows.manage',
  'leads.view',
  'leads.edit',
  'leads.reassign',
  'csv.import_export',
  'leads.archive',
  'analytics.team',
  'audit.view',
] as const;
export type Capability = (typeof CAPABILITIES)[number];

/** Rows follow the order of the table in section 6. Columns: Owner, Admin, Sales Manager, Sales Rep. */
export const ROLE_TABLE: Record<Capability, Record<Role, Access>> = {
  // Billing, plan changes, delete organization
  'billing.manage': { OWNER: 'all', ADMIN: 'none', MANAGER: 'none', REP: 'none' },
  // Organization settings, pipelines, stage SLAs
  'org.settings': { OWNER: 'all', ADMIN: 'all', MANAGER: 'none', REP: 'none' },
  // Invite and remove members, change roles
  'members.manage': { OWNER: 'all', ADMIN: 'not_owner', MANAGER: 'none', REP: 'none' },
  // Integrations, forms, webhook secrets
  'integrations.manage': { OWNER: 'all', ADMIN: 'all', MANAGER: 'none', REP: 'none' },
  // Create, edit, activate and pause workflows
  'workflows.manage': { OWNER: 'all', ADMIN: 'all', MANAGER: 'all', REP: 'none' },
  // View leads
  'leads.view': { OWNER: 'all', ADMIN: 'all', MANAGER: 'all', REP: 'assigned_and_pool' },
  // Edit leads
  'leads.edit': { OWNER: 'all', ADMIN: 'all', MANAGER: 'all', REP: 'assigned' },
  // Reassign leads
  'leads.reassign': { OWNER: 'all', ADMIN: 'all', MANAGER: 'all', REP: 'none' },
  // CSV import, CSV export
  'csv.import_export': { OWNER: 'all', ADMIN: 'all', MANAGER: 'all', REP: 'none' },
  // Archive and restore leads
  'leads.archive': { OWNER: 'all', ADMIN: 'all', MANAGER: 'all', REP: 'none' },
  // Team analytics
  'analytics.team': { OWNER: 'all', ADMIN: 'all', MANAGER: 'all', REP: 'own' },
  // Audit log
  'audit.view': { OWNER: 'all', ADMIN: 'all', MANAGER: 'none', REP: 'none' },
};

export function accessFor(role: Role, capability: Capability): Access {
  return ROLE_TABLE[capability][role];
}

/** True when the role has any access to the capability, scoped or not. */
export function can(role: Role, capability: Capability): boolean {
  return accessFor(role, capability) !== 'none';
}

/** Whether `actor` may grant `target` in an invitation or a role change. Admins cannot grant Owner. */
export function canGrantRole(actor: Role, target: Role): boolean {
  const access = accessFor(actor, 'members.manage');
  if (access === 'all') return true;
  if (access === 'not_owner') return target !== 'OWNER';
  return false;
}

/** Whether `actor` may change or remove a member who currently holds `current`. */
export function canManageMember(actor: Role, current: Role): boolean {
  return canGrantRole(actor, current);
}

export type MemberChange = { ok: true } | { ok: false; reason: 'FORBIDDEN' | 'LAST_OWNER' };

/**
 * Decides a role change or a removal (`nextRole` null).
 * The last Owner cannot be removed or demoted, whoever asks.
 */
export function decideMemberChange(input: {
  actorRole: Role;
  currentRole: Role;
  nextRole: Role | null;
  ownerCount: number;
}): MemberChange {
  const { actorRole, currentRole, nextRole, ownerCount } = input;
  if (!canManageMember(actorRole, currentRole)) return { ok: false, reason: 'FORBIDDEN' };
  if (nextRole !== null && !canGrantRole(actorRole, nextRole)) {
    return { ok: false, reason: 'FORBIDDEN' };
  }
  const losesOwner = currentRole === 'OWNER' && nextRole !== 'OWNER';
  if (losesOwner && ownerCount <= 1) return { ok: false, reason: 'LAST_OWNER' };
  return { ok: true };
}
