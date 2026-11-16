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

    const fail = vi.fn(async () => new Response('re_secret is invalid', { status: 401 }));
    await expect(resendEmailAdapter(from, 're_secret', fail).send(message)).rejects.toThrow(
      /^Resend rejected the email with status 401$/,
    );
  });
});
