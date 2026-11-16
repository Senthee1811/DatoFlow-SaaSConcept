/** Invitations expire after 7 days (ORG-03). */
export const INVITATION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export type InvitationState = 'PENDING' | 'ACCEPTED' | 'REVOKED' | 'EXPIRED';
export type InvitationProblem = 'EXPIRED' | 'USED' | 'REVOKED' | 'EMAIL_MISMATCH';

export function invitationExpiry(now: Date): Date {
  return new Date(now.getTime() + INVITATION_TTL_MS);
}

export function normaliseEmail(email: string): string {
  return email.trim().toLowerCase();
}

/**
 * Why an invitation cannot be accepted, or null when it can.
 * An invitation is single-use, must not be expired or revoked,
 * and must be accepted by the address it was sent to.
 * Pass `userEmail` null to check the invitation alone, before sign-in.
 */
export function invitationProblem(
  invitation: { status: InvitationState; expiresAt: Date; email: string },
  userEmail: string | null,
  now: Date,
): InvitationProblem | null {
  if (invitation.status === 'ACCEPTED') return 'USED';
  if (invitation.status === 'REVOKED') return 'REVOKED';
  if (invitation.status === 'EXPIRED' || invitation.expiresAt.getTime() <= now.getTime()) {
    return 'EXPIRED';
  }
  if (userEmail !== null && normaliseEmail(userEmail) !== normaliseEmail(invitation.email)) {
    return 'EMAIL_MISMATCH';
  }
  return null;
}
