import type { EmailAdapter, EmailMessage } from '@datoflow/adapters';
import { createApp } from '@datoflow/api';
import { loadServerEnv, type ServerEnv } from '@datoflow/shared';
import type { AddressInfo } from 'node:net';
import pg from 'pg';
import { inject } from 'vitest';

export const APP_URL = 'http://localhost:3000';

/** Captures every email the API sends. */
export class Outbox implements EmailAdapter {
  readonly name = 'console' as const;
  readonly sent: EmailMessage[] = [];

  async send(message: EmailMessage) {
    this.sent.push(message);
    return { id: `test-${this.sent.length}` };
  }

  /** The newest email to `to`, optionally matching a subject. */
  last(to: string, subject?: RegExp): EmailMessage {
    const found = [...this.sent]
      .reverse()
      .find((m) => m.to === to && (!subject || subject.test(m.subject)));
    if (!found) throw new Error(`No email to ${to}${subject ? ` matching ${subject}` : ''}`);
    return found;
  }

  /** The first link in the newest email to `to`. */
  link(to: string, subject?: RegExp): string {
    const match = this.last(to, subject).text.match(/https?:\/\/\S+/);
    if (!match) throw new Error(`No link in the email to ${to}`);
    return match[0];
  }
}

export interface TestApp {
  baseUrl: string;
  env: ServerEnv;
  outbox: Outbox;
  sql: pg.Pool;
  close(): Promise<void>;
}

export async function startApp(overrides: Record<string, string> = {}): Promise<TestApp> {
  const env = loadServerEnv({
    NODE_ENV: 'test',
    APP_URL,
    DATABASE_URL: inject('databaseUrl'),
    REDIS_URL: inject('redisUrl'),
    BETTER_AUTH_SECRET: 'test-secret-'.padEnd(48, 'x'),
    SECRETS_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64'),
    RATE_LIMIT_AUTH_PER_MIN: '10000',
    RATE_LIMIT_API_PER_MIN: '10000',
    ...overrides,
  });
  const outbox = new Outbox();
  const app = await createApp(env, {
    email: outbox,
    ...(process.env.TEST_LOG_LEVEL ? { logLevel: process.env.TEST_LOG_LEVEL } : {}),
  });
  await app.listen(0, '127.0.0.1');
  const { port } = app.getHttpServer().address() as AddressInfo;
  const sql = new pg.Pool({ connectionString: env.DATABASE_URL, max: 2 });
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    env,
    outbox,
    sql,
    async close() {
      await sql.end();
      await app.close();
    },
  };
}

export interface Res<T = any> {
  status: number;
  body: T;
  headers: Headers;
}

/** A browser-like client: keeps cookies and sends the Origin header Better Auth checks. */
export class Client {
  private cookies = new Map<string, string>();

  constructor(private readonly app: TestApp) {}

  get cookieHeader() {
    return [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; ');
  }

  async request<T = any>(
    method: string,
    path: string,
    body?: unknown,
    headers: Record<string, string> = {},
  ): Promise<Res<T>> {
    const url = path.startsWith('http')
      ? path.replace(APP_URL, this.app.baseUrl)
      : this.app.baseUrl + path;
    const res = await fetch(url, {
      method,
      redirect: 'manual',
      headers: {
        origin: APP_URL,
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        ...(this.cookies.size ? { cookie: this.cookieHeader } : {}),
        ...headers,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    for (const line of res.headers.getSetCookie()) {
      const [pair, ...attrs] = line.split(';');
      const [name, ...value] = pair!.split('=');
      const expired = attrs.some((a) => /max-age=0/i.test(a.trim()));
      if (expired || value.join('=') === '') this.cookies.delete(name!.trim());
      else this.cookies.set(name!.trim(), value.join('='));
    }
    const text = await res.text();
    let parsed: unknown = text;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      /* not JSON */
    }
    return { status: res.status, body: parsed as T, headers: res.headers };
  }

  get = <T = any>(path: string, headers?: Record<string, string>) =>
    this.request<T>('GET', path, undefined, headers);
  post = <T = any>(path: string, body: unknown = {}, headers?: Record<string, string>) =>
    this.request<T>('POST', path, body, headers);
  patch = <T = any>(path: string, body: unknown, headers?: Record<string, string>) =>
    this.request<T>('PATCH', path, body, headers);
  delete = <T = any>(path: string, headers?: Record<string, string>) =>
    this.request<T>('DELETE', path, undefined, headers);
}

let counter = 0;
export function uniqueEmail(label: string) {
  counter += 1;
  return `${label}.${Date.now().toString(36)}${counter}@example.test`;
}

export function uniqueSlug(label: string) {
  counter += 1;
  return `${label}-${Date.now().toString(36)}${counter}`;
}

export const PASSWORD = 'correct-horse-battery';

/** Signs up, follows the verification link and returns a signed-in client. */
export async function signUp(
  app: TestApp,
  label: string,
  name = label,
): Promise<{ client: Client; email: string; userId: string }> {
  const client = new Client(app);
  const email = uniqueEmail(label);
  const res = await client.post('/v1/auth/sign-up/email', { email, password: PASSWORD, name });
  if (res.status !== 200)
    throw new Error(`sign-up failed: ${res.status} ${JSON.stringify(res.body)}`);
  const verify = await client.get(app.outbox.link(email, /Confirm/));
  if (verify.status >= 400) throw new Error(`verify failed: ${verify.status}`);
  const me = await client.get('/v1/me');
  if (me.status !== 200) throw new Error(`not signed in after verification: ${me.status}`);
  return { client, email, userId: me.body.id };
}

export async function createOrg(client: Client, label: string) {
  const res = await client.post('/v1/orgs', {
    name: `${label} Agency`,
    slug: uniqueSlug(label),
    timezone: 'Asia/Colombo',
    currency: 'LKR',
  });
  if (res.status !== 201)
    throw new Error(`create org failed: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body as { id: string; slug: string; name: string };
}

/** Invites `email` into `orgId` and returns the raw token from the email. */
export async function invite(
  app: TestApp,
  admin: Client,
  orgId: string,
  email: string,
  role: string,
) {
  const res = await admin.post(`/v1/orgs/${orgId}/invitations`, { email, role });
  if (res.status !== 201)
    throw new Error(`invite failed: ${res.status} ${JSON.stringify(res.body)}`);
  const link = app.outbox.link(email, /invited you/);
  return { invitation: res.body as { id: string }, token: link.split('/invite/')[1]! };
}

/** Adds a member through the real invitation flow and returns their signed-in client. */
export async function addMember(
  app: TestApp,
  owner: Client,
  orgId: string,
  role: string,
  label = role.toLowerCase(),
) {
  const member = await signUp(app, label);
  const { token } = await invite(app, owner, orgId, member.email, role);
  const accepted = await member.client.post(`/v1/invitations/${token}/accept`);
  if (accepted.status !== 201 && accepted.status !== 200) {
    throw new Error(`accept failed: ${accepted.status} ${JSON.stringify(accepted.body)}`);
  }
  const members = await owner.get(`/v1/orgs/${orgId}/members?limit=100`);
  const membership = (members.body.items as { id: string; userId: string }[]).find(
    (m) => m.userId === member.userId,
  )!;
  return { ...member, membershipId: membership.id };
}

/** Moves an organization to another plan, for tests that need more seats than Free has. */
export async function setPlan(app: TestApp, orgId: string, planCode: string) {
  await app.sql.query('UPDATE "Organization" SET "planCode" = $1 WHERE id = $2', [planCode, orgId]);
}
