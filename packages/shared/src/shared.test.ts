import { describe, expect, it } from 'vitest';
import { createOrgSchema, loadServerEnv, stripSensitive, updateOrgSchema } from './index.js';

const base = {
  DATABASE_URL: 'postgresql://x',
  REDIS_URL: 'redis://x',
  BETTER_AUTH_SECRET: 'x'.repeat(32),
  SECRETS_ENCRYPTION_KEY: Buffer.alloc(32, 1).toString('base64'),
};

describe('env validation', () => {
  it('accepts the documented defaults', () => {
    expect(loadServerEnv(base).EMAIL_PROVIDER).toBe('console');
  });

  it('fails fast with the variable name', () => {
    expect(() => loadServerEnv({ ...base, DATABASE_URL: undefined })).toThrow(/DATABASE_URL/);
  });

  it('CAP-04: switching email provider needs only environment variables', () => {
    expect(() => loadServerEnv({ ...base, EMAIL_PROVIDER: 'smtp' })).toThrow(/SMTP_URL/);
    expect(
      loadServerEnv({ ...base, EMAIL_PROVIDER: 'smtp', SMTP_URL: 'smtp://h:1025' }).EMAIL_PROVIDER,
    ).toBe('smtp');
    expect(() => loadServerEnv({ ...base, EMAIL_PROVIDER: 'resend' })).toThrow(/RESEND_API_KEY/);
  });

  it('refuses the dev secret on a public production host', () => {
    const env = {
      ...base,
      NODE_ENV: 'production',
      BETTER_AUTH_SECRET: 'dev-only-' + 'x'.repeat(32),
    };
    expect(() => loadServerEnv({ ...env, APP_URL: 'https://app.example.com' })).toThrow(
      /BETTER_AUTH_SECRET/,
    );
    expect(loadServerEnv({ ...env, APP_URL: 'http://localhost:3000' }).NODE_ENV).toBe('production');
  });
});

describe('schemas', () => {
  it('ORG-01: validates and normalises name, slug, timezone and currency', () => {
    const ok = createOrgSchema.parse({
      name: ' Acme ',
      slug: 'Acme-Co',
      timezone: 'Asia/Colombo',
      currency: 'lkr',
    });
    expect(ok).toEqual({
      name: 'Acme',
      slug: 'acme-co',
      timezone: 'Asia/Colombo',
      currency: 'LKR',
      country: 'LK',
      withSampleData: true,
    });
    expect(createOrgSchema.safeParse({ ...ok, timezone: 'Mars/Olympus' }).success).toBe(false);
    expect(createOrgSchema.safeParse({ ...ok, slug: 'a--b' }).success).toBe(false);
  });

  it('rejects unknown fields (NFR-SEC-02)', () => {
    expect(updateOrgSchema.safeParse({ name: 'Acme', planCode: 'agency' }).success).toBe(false);
  });
});

describe('stripSensitive', () => {
  it('AUD-01: drops passwords, tokens and secrets from audit metadata', () => {
    const out = stripSensitive({
      email: 'a@b.co',
      password: 'p',
      nested: { tokenHash: 'h', role: 'REP' },
      list: [{ apiKey: 'k', ok: 1 }],
    });
    expect(out).toEqual({ email: 'a@b.co', nested: { role: 'REP' }, list: [{ ok: 1 }] });
  });
});
