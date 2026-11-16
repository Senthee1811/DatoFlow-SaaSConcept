import 'reflect-metadata';
import {
  type DynamicModule,
  type INestApplication,
  type LoggerService,
  Module,
} from '@nestjs/common';
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR, NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { DocumentBuilder, SwaggerModule, type OpenAPIObject } from '@nestjs/swagger';
import { apiReference } from '@scalar/nestjs-api-reference';
import { createEmailAdapter, type EmailAdapter } from '@datoflow/adapters';
import { createDb, type Db } from '@datoflow/db';
import { ErrorCode, LOG_REDACT_PATHS, type ServerEnv } from '@datoflow/shared';
import { toNodeHandler } from 'better-auth/node';
import express, { type NextFunction, type Request, type Response } from 'express';
import helmet from 'helmet';
import { Redis } from 'ioredis';
import { randomUUID } from 'node:crypto';
import { pino, type Logger } from 'pino';
import { pinoHttp } from 'pino-http';
import { AuditController } from './audit/audit.controller.js';
import { AUTH_BASE_PATH, createAuth, type Auth } from './auth/auth.js';
import { AccessGuard } from './auth/guards.js';
import { HealthController } from './health.controller.js';
import { ApiError, ProblemFilter, sendProblem, toProblem } from './http/errors.js';
import { IdempotencyInterceptor } from './http/idempotency.js';
import { hit } from './http/rate-limit.js';
import { clientIp } from './http/request.js';
import { MeController } from './me.controller.js';
import {
  InvitationTokenController,
  OrgInvitationsController,
} from './orgs/invitations.controller.js';
import { MembersController } from './orgs/members.controller.js';
import { OrgsController } from './orgs/orgs.controller.js';
import { WorkspaceController } from './orgs/workspace.controller.js';
import { LeadsController } from './leads/leads.controller.js';
import { LossReasonsController, PipelinesController } from './leads/pipelines.controller.js';
import { AUTH, DB, EMAIL, ENV, LOGGER, REDIS } from './tokens.js';

export interface AppDeps {
  env: ServerEnv;
  db: Db;
  redis: Redis;
  email: EmailAdapter;
  logger: Logger;
  auth: Auth;
}

export interface CreateAppOptions {
  /** Replaces the email adapter chosen by EMAIL_PROVIDER. Tests use it to read sent mail. */
  email?: EmailAdapter;
  /** Log level. Defaults to `info`, or `silent` under NODE_ENV=test. */
  logLevel?: string;
}

const REQUEST_ID = /^[A-Za-z0-9._-]{1,128}$/;

const RATE_LIMITED_AUTH_PATHS = [
  '/sign-in',
  '/sign-up',
  '/request-password-reset',
  '/forget-password',
  '/reset-password',
  '/verify-email',
  '/send-verification-email',
  '/change-password',
  '/callback',
];

@Module({})
class AppModule {
  static forRoot(deps: AppDeps): DynamicModule {
    return {
      module: AppModule,
      controllers: [
        HealthController,
        MeController,
        OrgsController,
        MembersController,
        OrgInvitationsController,
        InvitationTokenController,
        AuditController,
        WorkspaceController,
        LeadsController,
        PipelinesController,
        LossReasonsController,
      ],
      providers: [
        { provide: ENV, useValue: deps.env },
        { provide: DB, useValue: deps.db },
        { provide: REDIS, useValue: deps.redis },
        { provide: EMAIL, useValue: deps.email },
        { provide: LOGGER, useValue: deps.logger },
        { provide: AUTH, useValue: deps.auth },
        { provide: APP_GUARD, useClass: AccessGuard },
        { provide: APP_INTERCEPTOR, useClass: IdempotencyInterceptor },
        { provide: APP_FILTER, useClass: ProblemFilter },
      ],
    };
  }
}

function nestLogger(logger: Logger): LoggerService {
  const fmt = (message: unknown, context?: unknown) => ({ context, msg: String(message) });
  return {
    log: (m, c) => logger.info(fmt(m, c)),
    error: (m, t, c) => logger.error({ ...fmt(m, c), trace: t }),
    warn: (m, c) => logger.warn(fmt(m, c)),
    debug: (m, c) => logger.debug(fmt(m, c)),
    verbose: (m, c) => logger.trace(fmt(m, c)),
  };
}

export function buildOpenApi(app: INestApplication): OpenAPIObject {
  const config = new DocumentBuilder()
    .setTitle('DatoFlow API')
    .setDescription(
      'REST API for DatoFlow. Errors are RFC 9457 problem documents with a stable `code`. ' +
        'Lists use cursor pagination (`?cursor=&limit=`, limit up to 100). POST accepts an `Idempotency-Key` header.',
    )
    .setVersion('1')
    .addCookieAuth('datoflow.session_token')
    .build();
  return SwaggerModule.createDocument(app, config);
}

export async function createApp(env: ServerEnv, options: CreateAppOptions = {}) {
  const logger = pino({
    level: options.logLevel ?? (env.NODE_ENV === 'test' ? 'silent' : 'info'),
    redact: { paths: LOG_REDACT_PATHS, censor: '[redacted]' },
    base: { service: 'api' },
  });
  const db = createDb(env.DATABASE_URL);
  const redis = new Redis(env.REDIS_URL, { maxRetriesPerRequest: 1, lazyConnect: false });
  redis.on('error', (err) => logger.warn({ err: err.message }, 'redis error'));
  const email = options.email ?? createEmailAdapter(env);
  const auth = createAuth({ env, db, redis, email, logger });

  const app = await NestFactory.create<NestExpressApplication>(
    AppModule.forRoot({ env, db, redis, email, logger, auth }),
    {
      bodyParser: false,
      logger: nestLogger(logger),
    },
  );
  app.set('trust proxy', 'loopback, linklocal, uniquelocal');
  app.disable('x-powered-by');
  app.enableShutdownHooks();

  // Every request gets an id, echoed in X-Request-Id and present on every log line (NFR-OBS-01).
  app.use(
    pinoHttp({
      logger,
      genReqId(req, res) {
        const incoming = req.headers['x-request-id'];
        const id =
          typeof incoming === 'string' && REQUEST_ID.test(incoming) ? incoming : randomUUID();
        res.setHeader('x-request-id', id);
        return id;
      },
      autoLogging: { ignore: (req) => req.url?.startsWith('/health') ?? false },
      customProps: (req) => ({ requestId: req.id }),
    }),
  );

  // API docs: Scalar needs its own script, so the strict CSP below does not apply here.
  const document = buildOpenApi(app);
  app.use('/v1/openapi.json', (_req: Request, res: Response) => res.json(document));
  app.use('/v1/docs', apiReference({ content: document }));

  app.use(
    helmet({
      contentSecurityPolicy: { directives: { defaultSrc: ["'none'"], frameAncestors: ["'none'"] } },
      strictTransportSecurity: { maxAge: 63072000, includeSubDomains: true },
    }),
  );

  // Auth routes: 5 requests per minute per IP on the endpoints that take credentials or send
  // email (NFR-SEC-04). Reading the session, signing out and switching workspace are not counted.
  app.use(AUTH_BASE_PATH, async (req: Request, res: Response, next: NextFunction) => {
    if (!RATE_LIMITED_AUTH_PATHS.some((p) => req.path === p || req.path.startsWith(`${p}/`)))
      return next();
    const result = await hit(redis, `auth:${clientIp(req)}`, env.RATE_LIMIT_AUTH_PER_MIN, 60);
    if (result.allowed) return next();
    res.setHeader('retry-after', String(result.retryAfterSeconds));
    sendProblem(
      res,
      toProblem(
        new ApiError(429, ErrorCode.RATE_LIMITED, 'Too many attempts. Wait a minute and try again'),
        req,
      ),
    );
  });
  // Better Auth reads its own body, so it is mounted before the JSON parser.
  app.use(AUTH_BASE_PATH, toNodeHandler(auth));

  app.use(express.json({ limit: '1mb', type: ['application/json', 'application/*+json'] }));
  app.use(express.urlencoded({ extended: false, limit: '1mb' }));

  return app;
}

export { createDb, type Db };
