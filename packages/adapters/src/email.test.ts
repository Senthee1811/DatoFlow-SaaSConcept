import { describe, expect, it, vi } from 'vitest';
import { consoleEmailAdapter, createEmailAdapter, resendEmailAdapter } from './email.js';

const from = 'DatoFlow <no-reply@datoflow.local>';
const message = {
  to: 'rep@agency.co',
  subject: 'Join Northwind',
  text: 'Open http://x/invite/abc',
};

describe('email adapter', () => {
  it('CAP-04: the provider is chosen by EMAIL_PROVIDER alone', () => {
    expect(createEmailAdapter({ EMAIL_PROVIDER: 'console', EMAIL_FROM: from }).name).toBe(
      'console',
    );
    expect(
      createEmailAdapter({
        EMAIL_PROVIDER: 'smtp',
        EMAIL_FROM: from,
        SMTP_URL: 'smtp://localhost:1025',
      }).name,
    ).toBe('smtp');
    expect(
      createEmailAdapter({ EMAIL_PROVIDER: 'resend', EMAIL_FROM: from, RESEND_API_KEY: 're_x' })
        .name,
    ).toBe('resend');
  });

  it('CAP-04: a provider without its credentials fails with the variable name', () => {
    expect(() => createEmailAdapter({ EMAIL_PROVIDER: 'smtp', EMAIL_FROM: from })).toThrow(
      /SMTP_URL/,
    );
    expect(() => createEmailAdapter({ EMAIL_PROVIDER: 'resend', EMAIL_FROM: from })).toThrow(
      /RESEND_API_KEY/,
    );
  });

  it('CAP-04: the console adapter writes the message as one JSON line', async () => {
    const lines: string[] = [];
    const { id } = await consoleEmailAdapter(from, (l) => lines.push(l)).send(message);
    expect(id).toBe('console-1');
    expect(JSON.parse(lines[0]!)).toMatchObject({ provider: 'console', to: message.to, from });
  });

  it('TASK-04: only Resend promises to drop a repeated send', () => {
    expect(consoleEmailAdapter(from).idempotent).toBe(false);
    expect(resendEmailAdapter(from, 're_x').idempotent).toBe(true);
    expect(
      createEmailAdapter({ EMAIL_PROVIDER: 'smtp', EMAIL_FROM: from, SMTP_URL: 'smtp://x:1025' })
        .idempotent,
    ).toBe(false);
  });

  it('CAP-04: the Resend adapter posts to the Resend API and hides the key on failure', async () => {
    const ok = vi.fn(async () => new Response(JSON.stringify({ id: 'e_1' }), { status: 200 }));
    await expect(resendEmailAdapter(from, 're_secret', ok).send(message)).resolves.toEqual({
      id: 'e_1',
    });
    const [url, init] = ok.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://api.resend.com/emails');
    expect(JSON.parse(String(init.body))).toEqual({
      from,
      to: [message.to],
      subject: message.subject,
      text: message.text,
    });

    expect((init.headers as Record<string, string>)['idempotency-key']).toBeUndefined();

    await resendEmailAdapter(from, 're_secret', ok).send({
      ...message,
      idempotencyKey: 'reminder:t1:EMAIL:2026-11-17T03:00:00.000Z',
    });
    const [, keyed] = ok.mock.calls[1] as unknown as [string, RequestInit];
    expect((keyed.headers as Record<string, string>)['idempotency-key']).toBe(
      'reminder:t1:EMAIL:2026-11-17T03:00:00.000Z',
    );
    // The key travels as a header, never in the body.
    expect(JSON.parse(String(keyed.body))).not.toHaveProperty('idempotencyKey');

    const fail = vi.fn(async () => new Response('re_secret is invalid', { status: 401 }));
    await expect(resendEmailAdapter(from, 're_secret', fail).send(message)).rejects.toThrow(
      /^Resend rejected the email with status 401$/,
    );
  });
});
