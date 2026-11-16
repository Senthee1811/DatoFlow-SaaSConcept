import type { Db, Tx } from '@datoflow/db';
import { stripSensitive } from '@datoflow/shared';
import type { Request } from 'express';
import { clientIp } from '../http/request.js';

/**
 * Audit actions recorded so far. Phase 1 covers auth, organization, role and invitation events.
 * The log is append-only and never stores passwords, tokens or full secrets (AUD-01).
 */
export type AuditAction =
  | 'auth.signed_in'
  | 'auth.sign_in_failed'
  | 'auth.signed_out'
  | 'auth.password_reset'
  | 'auth.sessions_revoked'
  | 'org.created'
  | 'org.updated'
  | 'member.role_changed'
  | 'member.removed'
  | 'invitation.created'
  | 'invitation.resent'
  | 'invitation.revoked'
  | 'invitation.accepted'
  | 'pipeline.updated'
  | 'loss_reasons.updated'
  | 'sample.deleted';

export interface AuditEntry {
  action: AuditAction;
  targetType?: string;
  targetId?: string;
  metadata?: Record<string, unknown>;
}

export interface AuditActor {
  actorId: string | null;
  ip: string | null;
  userAgent: string | null;
}

export function actorFrom(req: Request): AuditActor {
  return {
    actorId: req.user?.id ?? null,
    ip: clientIp(req),
    userAgent: req.get('user-agent')?.slice(0, 512) ?? null,
  };
}

function row(organizationId: string, actor: AuditActor, entry: AuditEntry) {
  return {
    organizationId,
    action: entry.action,
    actorId: actor.actorId,
    targetType: entry.targetType ?? null,
    targetId: entry.targetId ?? null,
    ip: actor.ip,
    userAgent: actor.userAgent,
    metadata: stripSensitive(entry.metadata ?? {}) as object,
  };
}

/** Writes one audit row inside the caller's transaction, so it commits with the change. */
export async function audit(tx: Tx, organizationId: string, actor: AuditActor, entry: AuditEntry) {
  await tx.auditLog.create({ data: row(organizationId, actor, entry) });
}

/**
 * Auth events belong to a person, not to one organization. They are recorded in every
 * organization the person is a member of, so each workspace's Admins can see them.
 * A person with no membership yet has nowhere to record them; the request log still has it.
 */
export async function auditForUser(db: Db, userId: string, actor: AuditActor, entry: AuditEntry) {
  await db.withSystem(async (tx) => {
    const memberships = await tx.organizationMembership.findMany({
      where: { userId },
      select: { organizationId: true },
    });
    if (memberships.length === 0) return;
    await tx.auditLog.createMany({
      data: memberships.map((m) => row(m.organizationId, actor, entry)),
    });
  });
}
