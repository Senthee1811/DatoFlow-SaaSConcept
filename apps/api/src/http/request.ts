import type { Role } from '@datoflow/domain';

export interface AuthUser {
  id: string;
  email: string;
  name: string;
  emailVerified: boolean;
}

export interface AuthSession {
  id: string;
  activeOrganizationId: string | null;
}

export interface Membership {
  id: string;
  organizationId: string;
  userId: string;
  role: Role;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: AuthUser;
      authSession?: AuthSession;
      membership?: Membership;
    }
  }
}

export function clientIp(req: {
  ip?: string | undefined;
  socket?: { remoteAddress?: string | undefined };
}) {
  return req.ip ?? req.socket?.remoteAddress ?? 'unknown';
}
