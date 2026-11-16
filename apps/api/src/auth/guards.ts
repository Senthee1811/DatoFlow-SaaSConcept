import {
  type CanActivate,
  createParamDecorator,
  type ExecutionContext,
  Inject,
  Injectable,
  SetMetadata,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Db } from '@datoflow/db';
import { can, type Capability, type Role } from '@datoflow/domain';
import { ErrorCode, idParam, type ServerEnv } from '@datoflow/shared';
import { fromNodeHeaders } from 'better-auth/node';
import type { Request, Response } from 'express';
import type { Redis } from 'ioredis';
import { ApiError } from '../http/errors.js';
import { hit } from '../http/rate-limit.js';
import type { AuthUser, Membership } from '../http/request.js';
import { AUTH, DB, ENV, REDIS } from '../tokens.js';
import type { Auth } from './auth.js';

const AUTH_MODE = 'datoflow:auth-mode';
const CAPABILITY = 'datoflow:capability';

/** No session needed. */
export const Public = () => SetMetadata(AUTH_MODE, 'public');
/** A session is read when present, but not required. */
export const OptionalAuth = () => SetMetadata(AUTH_MODE, 'optional');
/**
 * The route takes `:orgId`. The caller must be a member (else 404) and, when a capability
 * is given, the role table must allow it (else 403).
 */
export const OrgRoute = (capability?: Capability) =>
  SetMetadata(CAPABILITY, capability ?? 'member');

export const CurrentUser = createParamDecorator((_: unknown, ctx: ExecutionContext): AuthUser => {
  const user = ctx.switchToHttp().getRequest<Request>().user;
  if (!user) throw new ApiError(401, ErrorCode.UNAUTHENTICATED, 'Sign in to continue');
  return user;
});

export const CurrentMembership = createParamDecorator(
  (_: unknown, ctx: ExecutionContext): Membership => {
    const membership = ctx.switchToHttp().getRequest<Request>().membership;
    if (!membership) throw new Error('CurrentMembership used on a route without @OrgRoute');
    return membership;
  },
);

/**
 * Global guard. Resolves the Better Auth session from the cookie, applies the per-user
 * API rate limit, and for @OrgRoute routes resolves the membership and checks the role.
 */
@Injectable()
export class AccessGuard implements CanActivate {
  constructor(
    @Inject(Reflector) private readonly reflector: Reflector,
    @Inject(AUTH) private readonly auth: Auth,
    @Inject(DB) private readonly db: Db,
    @Inject(REDIS) private readonly redis: Redis,
    @Inject(ENV) private readonly env: ServerEnv,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<Request>();
    const res = context.switchToHttp().getResponse<Response>();
    const targets = [context.getHandler(), context.getClass()];
    const mode = this.reflector.getAllAndOverride<string>(AUTH_MODE, targets) ?? 'required';
    if (mode === 'public') return true;

    const result = await this.auth.api.getSession({ headers: fromNodeHeaders(req.headers) });
    if (result) {
      req.user = {
        id: result.user.id,
        email: result.user.email,
        name: result.user.name,
        emailVerified: result.user.emailVerified,
      };
      req.authSession = {
        id: result.session.id,
        activeOrganizationId:
          (result.session as { activeOrganizationId?: string | null }).activeOrganizationId ?? null,
      };
    }
    if (mode === 'required' && !req.user) {
      throw new ApiError(401, ErrorCode.UNAUTHENTICATED, 'Sign in to continue');
    }

    if (req.user) {
      const limit = await hit(
        this.redis,
        `api:${req.user.id}`,
        this.env.RATE_LIMIT_API_PER_MIN,
        60,
      );
      if (!limit.allowed) {
        res.setHeader('retry-after', String(limit.retryAfterSeconds));
        throw new ApiError(429, ErrorCode.RATE_LIMITED, 'Too many requests. Slow down a little.');
      }
    }

    const capability = this.reflector.getAllAndOverride<Capability | 'member'>(CAPABILITY, targets);
    if (capability) await this.resolveMembership(req, capability);
    return true;
  }

  private async resolveMembership(req: Request, capability: Capability | 'member') {
    const user = req.user!;
    const parsed = idParam.safeParse(req.params.orgId);
    // No membership, a deleted organization and a malformed id all look the same: 404 (ORG-02).
    if (!parsed.success) throw ApiError.notFound('Organization');
    const membership = await this.db.withSystem((tx) =>
      tx.organizationMembership.findFirst({
        where: { userId: user.id, organizationId: parsed.data, organization: { deletedAt: null } },
        select: { id: true, organizationId: true, userId: true, role: true },
      }),
    );
    if (!membership) throw ApiError.notFound('Organization');
    req.membership = { ...membership, role: membership.role as Role };
    if (capability !== 'member' && !can(req.membership.role, capability)) {
      throw ApiError.forbidden();
    }
  }
}
