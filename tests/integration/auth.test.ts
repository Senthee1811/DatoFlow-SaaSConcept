import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  Client,
  createOrg,
  PASSWORD,
  signUp,
  startApp,
  uniqueEmail,
  type TestApp,
} from './harness.js';

let app: TestApp;
beforeAll(async () => {
  app = await startApp();
});
afterAll(() => app.close());

async function signIn(email: string, password = PASSWORD) {
  const client = new Client(app);
  const res = await client.post('/v1/auth/sign-in/email', { email, password });
  return { client, res };
}

describe('AUTH-01 sign up, verify, sign in, sign out', () => {
  it('AUTH-01: an unverified user cannot sign in, and is signed in after following the link', async () => {
    const client = new Client(app);
    const email = uniqueEmail('verify');
    const signUpRes = await client.post('/v1/auth/sign-up/email', {
      email,
      password: PASSWORD,
      name: 'Nimal',
    });
    expect(signUpRes.status).toBe(200);
    expect(signUpRes.body.token).toBeNull();
    expect((await client.get('/v1/me')).status).toBe(401);

    const blocked = await signIn(email);
    expect(blocked.res.status).toBe(403);

    await client.get(app.outbox.link(email, /Confirm/));
    const me = await client.get('/v1/me');
    expect(me.status).toBe(200);
    expect(me.body).toMatchObject({ email, emailVerified: true });
  });

  it('AUTH-01: sign out ends the session', async () => {
    const { client } = await signUp(app, 'signout');
    expect((await client.post('/v1/auth/sign-out')).status).toBe(200);
    expect((await client.get('/v1/me')).status).toBe(401);
  });

  it('AUTH-01: a wrong password is refused', async () => {
    const { email } = await signUp(app, 'wrongpw');
    expect((await signIn(email, 'not-the-password')).res.status).toBe(401);
  });

  it('AUTH-01: unverified users cannot create an org', async () => {
    const { client, userId } = await signUp(app, 'unverified');
    await app.sql.query('UPDATE "User" SET "emailVerified" = false WHERE id = $1', [userId]);
    const res = await client.post('/v1/orgs', {
      name: 'Blocked',
      slug: 'blocked-org-x',
      timezone: 'UTC',
      currency: 'USD',
    });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('EMAIL_NOT_VERIFIED');
    expect((await new Client(app).post('/v1/orgs', {})).status).toBe(401);
  });

  it('AUTH-01: Google sign-in is unavailable when no Google credentials are set', async () => {
    const res = await new Client(app).post('/v1/auth/sign-in/social', { provider: 'google' });
    expect(res.status).toBeGreaterThanOrEqual(400);
  });
});

describe('AUTH-02 password reset and revoking sessions', () => {
  async function requestReset(email: string) {
    return new Client(app).post('/v1/auth/request-password-reset', {
      email,
      redirectTo: '/reset-password',
    });
  }

  function resetToken(email: string) {
    const link = app.outbox.link(email, /Reset/);
    const match = link.match(/reset-password\/([^?/]+)/);
    if (!match) throw new Error(`no token in ${link}`);
    return match[1]!;
  }

  it('AUTH-02: the reset token works once', async () => {
    const { email } = await signUp(app, 'reset');
    expect((await requestReset(email)).status).toBe(200);
    const token = resetToken(email);
    const anon = new Client(app);
    expect(
      (await anon.post('/v1/auth/reset-password', { token, newPassword: 'a-new-password-1' }))
        .status,
    ).toBe(200);
    expect(
      (await anon.post('/v1/auth/reset-password', { token, newPassword: 'another-password-2' }))
        .status,
    ).toBe(400);
    expect((await signIn(email, 'a-new-password-1')).res.status).toBe(200);
    expect((await signIn(email, PASSWORD)).res.status).toBe(401);
  });

  it('AUTH-02: the reset token expires after 30 minutes', async () => {
    const { email } = await signUp(app, 'expire');
    await requestReset(email);
    const token = resetToken(email);
    const { rows } = await app.sql.query(
      `SELECT EXTRACT(EPOCH FROM ("expiresAt" - "createdAt")) AS seconds FROM "Verification" WHERE identifier = $1`,
      [`reset-password:${token}`],
    );
    expect(Number(rows[0].seconds)).toBeCloseTo(1800, -1);
    await app.sql.query(
      `UPDATE "Verification" SET "expiresAt" = now() - interval '1 second' WHERE identifier = $1`,
      [`reset-password:${token}`],
    );
    const res = await new Client(app).post('/v1/auth/reset-password', {
      token,
      newPassword: 'too-late-password',
    });
    expect(res.status).toBe(400);
  });

  it('AUTH-02: 5 reset requests per hour per email, the 6th is 429', async () => {
    const { email } = await signUp(app, 'flood');
    for (let i = 0; i < 5; i++) expect((await requestReset(email)).status).toBe(200);
    expect((await requestReset(email)).status).toBe(429);
    // Another address is not affected.
    const other = await signUp(app, 'flood-other');
    expect((await requestReset(other.email)).status).toBe(200);
  });

  it('AUTH-02: revoke all sessions signs out every device', async () => {
    const { client, email } = await signUp(app, 'revoke');
    const laptop = await signIn(email);
    expect((await laptop.client.get('/v1/me')).status).toBe(200);
    expect((await client.post('/v1/auth/revoke-sessions')).status).toBe(200);
    expect((await client.get('/v1/me')).status).toBe(401);
    expect((await laptop.client.get('/v1/me')).status).toBe(401);
  });

  it('AUTH-02: a password reset revokes existing sessions', async () => {
    const { client, email } = await signUp(app, 'reset-revoke');
    await requestReset(email);
    await new Client(app).post('/v1/auth/reset-password', {
      token: resetToken(email),
      newPassword: 'fresh-password-9',
    });
    expect((await client.get('/v1/me')).status).toBe(401);
  });
});

describe('AUD-01 auth events', () => {
  it('AUD-01: sign-in, failed sign-in, sign-out, reset and session revocation are audited without secrets', async () => {
    const owner = await signUp(app, 'auditauth');
    const org = await createOrg(owner.client, 'auditauth');
    const second = await signIn(owner.email);
    await signIn(owner.email, 'wrong-password-here');
    await second.client.post('/v1/auth/sign-out');
    await new Client(app).post('/v1/auth/request-password-reset', {
      email: owner.email,
      redirectTo: '/reset-password',
    });
    const token = app.outbox.link(owner.email, /Reset/).match(/reset-password\/([^?/]+)/)![1]!;
    await new Client(app).post('/v1/auth/reset-password', {
      token,
      newPassword: 'post-reset-password',
    });
    const third = await signIn(owner.email, 'post-reset-password');
    await third.client.post('/v1/auth/revoke-sessions');

    const { rows } = await app.sql.query(
      `SELECT action, metadata::text AS metadata FROM "AuditLog" WHERE "organizationId" = $1 ORDER BY "createdAt"`,
      [org.id],
    );
    const actions = rows.map((r) => r.action);
    for (const action of [
      'org.created',
      'auth.signed_in',
      'auth.sign_in_failed',
      'auth.signed_out',
      'auth.password_reset',
      'auth.sessions_revoked',
    ]) {
      expect(actions, action).toContain(action);
    }
    const everything = JSON.stringify(rows);
    expect(everything).not.toContain(token);
    expect(everything).not.toContain('post-reset-password');
    expect(everything).not.toMatch(/password"|token"/i);
  });
});
