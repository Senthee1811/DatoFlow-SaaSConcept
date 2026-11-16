import type { EmailAdapter } from '@datoflow/adapters';
import type { Db } from '@datoflow/db';
import type { ServerEnv } from '@datoflow/shared';
import { betterAuth } from 'better-auth';
import { prismaAdapter } from 'better-auth/adapters/prisma';
import { APIError, createAuthMiddleware, getSessionFromCtx } from 'better-auth/api';
import { organization } from 'better-auth/plugins';
import type { Redis } from 'ioredis';
import type { Logger } from 'pino';
import { auditForUser, type AuditActor } from '../audit/audit.js';
import { hit } from '../http/rate-limit.js';

export const AUTH_BASE_PATH = '/v1/auth';

/** Better Auth organization endpoints DatoFlow lets through. Everything else under /organization/ is a 404. */
const ORGANIZATION_PATHS_ALLOWED = new Set(['/organization/set-active']);

/** Password reset requests per email per hour (AUTH-02). */
export const RESET_REQUESTS_PER_HOUR = 5;

export interface AuthDeps {
  env: ServerEnv;
  db: Db;
  redis: Redis;
  email: EmailAdapter;
  logger: Logger;
}

type HookCtx = {
  path: string;
  body?: unknown;
  headers?: Headers;
  request?: Request;
};

function actorFromCtx(ctx: HookCtx, actorId: string | null): AuditActor {
  const headers = ctx.headers ?? ctx.request?.headers;
  const forwarded = headers?.get('x-forwarded-for')?.split(',')[0]?.trim();
  return {
    actorId,
    ip: forwarded ?? null,
    userAgent: headers?.get('user-agent')?.slice(0, 512) ?? null,
  };
}

function bodyEmail(ctx: HookCtx): string | null {
  const email = (ctx.body as { email?: unknown } | undefined)?.email;
  return typeof email === 'string' ? email.trim().toLowerCase() : null;
}

export function createAuth({ env, db, redis, email, logger }: AuthDeps) {
  const secure = env.APP_URL.startsWith('https://');

  // Auth events are audited on a best-effort basis: a failed audit write must never block sign-in.
  const record = (userId: string, actor: AuditActor, action: Parameters<typeof auditForUser>[3]) =>
    auditForUser(db, userId, actor, action).catch((err: unknown) =>
      logger.error({ err, action: action.action }, 'auth audit write failed'),
    );

  return betterAuth({
    appName: 'DatoFlow',
    baseURL: env.APP_URL,
    basePath: AUTH_BASE_PATH,
    secret: env.BETTER_AUTH_SECRET,
    trustedOrigins: [env.APP_URL],
    database: prismaAdapter(db.raw, { provider: 'postgresql' }),
    telemetry: { enabled: false },
    // DatoFlow's own Redis limiter covers auth routes (5/min per IP), so the built-in one is off.
    rateLimit: { enabled: false },
    emailAndPassword: {
      enabled: true,
      requireEmailVerification: true,
      minPasswordLength: 10,
      maxPasswordLength: 128,
      resetPasswordTokenExpiresIn: 30 * 60,
      revokeSessionsOnPasswordReset: true,
      async sendResetPassword({ user, url }) {
        await email.send({
          to: user.email,
          subject: 'Reset your DatoFlow password',
          text: `Someone asked to reset the password for this address.\n\nSet a new password here, within 30 minutes:\n${url}\n\nIf this was not you, ignore this email. Your password stays the same.`,
        });
      },
      async onPasswordReset({ user }, request) {
        await record(user.id, actorFromCtx({ path: '', request }, user.id), {
          action: 'auth.password_reset',
          targetType: 'User',
          targetId: user.id,
        });
      },
    },
    emailVerification: {
      sendOnSignUp: true,
      autoSignInAfterVerification: true,
      expiresIn: 24 * 60 * 60,
      async sendVerificationEmail({ user, url }) {
        await email.send({
          to: user.email,
          subject: 'Confirm your email for DatoFlow',
          text: `Confirm this address to finish setting up DatoFlow:\n${url}\n\nThe link works for 24 hours.`,
        });
      },
    },
    ...(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET
      ? {
          socialProviders: {
            google: { clientId: env.GOOGLE_CLIENT_ID, clientSecret: env.GOOGLE_CLIENT_SECRET },
          },
        }
      : {}),
    session: {
      expiresIn: 60 * 60 * 24 * 14,
      updateAge: 60 * 60 * 24,
    },
    advanced: {
      useSecureCookies: secure,
      cookiePrefix: 'datoflow',
      defaultCookieAttributes: { httpOnly: true, sameSite: 'lax', secure },
      ipAddress: { ipAddressHeaders: ['x-forwarded-for'] },
    },
    plugins: [
      // Used for the active organization on the session (ORG-02). Roles, invitations and members
      // live in DatoFlow's own tables and API, so the plugin's other endpoints are blocked below.
      organization({
        schema: {
          member: { modelName: 'organizationMembership' },
        },
      }),
    ],
    databaseHooks: {
      session: {
        create: {
          async after(session) {
            await record(
              session.userId,
              {
                actorId: session.userId,
                ip: session.ipAddress ?? null,
                userAgent: session.userAgent ?? null,
              },
              { action: 'auth.signed_in', targetType: 'Session', targetId: session.id },
            );
          },
        },
      },
    },
    hooks: {
      before: createAuthMiddleware(async (ctx) => {
        if (ctx.path.startsWith('/organization/') && !ORGANIZATION_PATHS_ALLOWED.has(ctx.path)) {
          throw new APIError('NOT_FOUND');
        }
        if (ctx.path === '/request-password-reset' || ctx.path === '/forget-password') {
          const address = bodyEmail(ctx);
          if (address) {
            const result = await hit(redis, `reset:${address}`, RESET_REQUESTS_PER_HOUR, 3600);
            if (!result.allowed) {
              throw new APIError('TOO_MANY_REQUESTS', {
                message: 'Too many reset requests for this email. Try again in an hour.',
              });
            }
          }
        }
        if (ctx.path === '/sign-out' || ctx.path === '/revoke-sessions') {
          const current = await getSessionFromCtx(ctx).catch(() => null);
          if (current) {
            await record(current.user.id, actorFromCtx(ctx, current.user.id), {
              action: ctx.path === '/sign-out' ? 'auth.signed_out' : 'auth.sessions_revoked',
              targetType: 'User',
              targetId: current.user.id,
            });
          }
        }
      }),
      after: createAuthMiddleware(async (ctx) => {
        if (ctx.path !== '/sign-in/email') return;
        const returned = ctx.context.returned;
        if (!(returned instanceof APIError)) return;
        const address = bodyEmail(ctx);
        if (!address) return;
        const user = await db.raw.user.findUnique({
          where: { email: address },
          select: { id: true },
        });
        if (user) {
          await record(user.id, actorFromCtx(ctx, null), {
            action: 'auth.sign_in_failed',
            targetType: 'User',
            targetId: user.id,
            metadata: { status: returned.status },
          });
        }
      }),
    },
  });
}

export type Auth = ReturnType<typeof createAuth>;
