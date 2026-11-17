import { z } from 'zod';

const optional = z
  .string()
  .optional()
  .transform((v) => (v && v.trim() !== '' ? v.trim() : undefined));
const url = z.url();

/** Server environment for the API and the worker. Only NEXT_PUBLIC_* may reach the browser. */
export const serverEnvSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    APP_URL: url.default('http://localhost:3000'),
    API_URL: url.default('http://localhost:4000'),
    API_PORT: z.coerce.number().int().default(4000),
    WORKER_PORT: z.coerce.number().int().default(4100),
    DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
    REDIS_URL: z.string().min(1, 'REDIS_URL is required'),
    BETTER_AUTH_SECRET: z.string().min(32, 'BETTER_AUTH_SECRET must be at least 32 characters'),
    GOOGLE_CLIENT_ID: optional,
    GOOGLE_CLIENT_SECRET: optional,
    SECRETS_ENCRYPTION_KEY: z
      .string()
      .refine((v) => Buffer.from(v, 'base64').length === 32, 'must be 32 bytes, base64 encoded'),
    EMAIL_PROVIDER: z.enum(['console', 'resend', 'smtp']).default('console'),
    RESEND_API_KEY: optional,
    SMTP_URL: optional,
    EMAIL_FROM: z.string().default('DatoFlow <no-reply@datoflow.local>'),
    EMAIL_DAILY_LIMIT: z.coerce.number().int().positive().default(100),
    /** Stuck-lead radar sweep (TASK-03): every 5 minutes. */
    RADAR_INTERVAL_SECONDS: z.coerce.number().int().min(5).default(300),
    /** Reminder, digest and email run (TASK-04): every minute. */
    REMINDER_INTERVAL_SECONDS: z.coerce.number().int().min(5).default(60),
    RATE_LIMIT_AUTH_PER_MIN: z.coerce.number().int().positive().default(5),
    RATE_LIMIT_API_PER_MIN: z.coerce.number().int().positive().default(300),
    CAPTCHA_PROVIDER: z.enum(['noop', 'turnstile']).default('noop'),
    TURNSTILE_SITE_KEY: optional,
    TURNSTILE_SECRET_KEY: optional,
    STORAGE_PROVIDER: z.enum(['local', 'r2']).default('local'),
    R2_ACCOUNT_ID: optional,
    R2_ACCESS_KEY_ID: optional,
    R2_SECRET_ACCESS_KEY: optional,
    R2_BUCKET: optional,
    BILLING_PROVIDER: z.enum(['noop', 'polar']).default('noop'),
    POLAR_ACCESS_TOKEN: optional,
    POLAR_WEBHOOK_SECRET: optional,
    SENTRY_DSN: optional,
  })
  .superRefine((env, ctx) => {
    const need = (cond: boolean, key: string, why: string) => {
      if (cond) ctx.addIssue({ code: 'custom', path: [key], message: `is required when ${why}` });
    };
    need(
      env.EMAIL_PROVIDER === 'resend' && !env.RESEND_API_KEY,
      'RESEND_API_KEY',
      'EMAIL_PROVIDER=resend',
    );
    need(env.EMAIL_PROVIDER === 'smtp' && !env.SMTP_URL, 'SMTP_URL', 'EMAIL_PROVIDER=smtp');
    need(
      Boolean(env.GOOGLE_CLIENT_ID) !== Boolean(env.GOOGLE_CLIENT_SECRET),
      'GOOGLE_CLIENT_SECRET',
      'GOOGLE_CLIENT_ID is set (set both or neither)',
    );
    if (env.NODE_ENV === 'production' && env.BETTER_AUTH_SECRET.startsWith('dev-only')) {
      // The Compose default is fine on localhost, never on a public host.
      const local = /\/\/(localhost|127\.0\.0\.1)(:|\/|$)/.test(env.APP_URL);
      need(!local, 'BETTER_AUTH_SECRET', 'APP_URL is not localhost (the dev default is refused)');
    }
  });

export type ServerEnv = z.infer<typeof serverEnvSchema>;

/** Parses the environment and fails fast with one readable message. */
export function loadServerEnv(source: Record<string, string | undefined> = process.env): ServerEnv {
  const parsed = serverEnvSchema.safeParse(source);
  if (!parsed.success) {
    const lines = parsed.error.issues.map((i) => `  ${i.path.join('.') || '(env)'}: ${i.message}`);
    throw new Error(`Invalid environment:\n${lines.join('\n')}\nSee .env.example.`);
  }
  return parsed.data;
}
