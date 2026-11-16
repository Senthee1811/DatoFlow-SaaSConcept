import nodemailer from 'nodemailer';

export interface EmailMessage {
  to: string;
  subject: string;
  /** Plain text body. Links are written out in full. */
  text: string;
}

export interface EmailAdapter {
  readonly name: 'console' | 'smtp' | 'resend';
  send(message: EmailMessage): Promise<{ id: string }>;
}

export interface EmailConfig {
  EMAIL_PROVIDER: 'console' | 'smtp' | 'resend';
  EMAIL_FROM: string;
  SMTP_URL?: string;
  RESEND_API_KEY?: string;
}

type Fetch = typeof fetch;

/** Dev fallback. Prints the message so links can be copied from the logs. */
export function consoleEmailAdapter(
  from: string,
  write: (line: string) => void = (line) => process.stdout.write(line + '\n'),
): EmailAdapter {
  let n = 0;
  return {
    name: 'console',
    async send(message) {
      const id = `console-${++n}`;
      write(JSON.stringify({ level: 30, msg: 'email', provider: 'console', id, from, ...message }));
      return { id };
    },
  };
}

export function smtpEmailAdapter(from: string, smtpUrl: string): EmailAdapter {
  const transport = nodemailer.createTransport(smtpUrl);
  return {
    name: 'smtp',
    async send(message) {
      const info = await transport.sendMail({ from, ...message });
      return { id: String(info.messageId) };
    },
  };
}

export function resendEmailAdapter(
  from: string,
  apiKey: string,
  fetchImpl: Fetch = fetch,
): EmailAdapter {
  return {
    name: 'resend',
    async send(message) {
      const res = await fetchImpl('https://api.resend.com/emails', {
        method: 'POST',
        headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          from,
          to: [message.to],
          subject: message.subject,
          text: message.text,
        }),
      });
      if (!res.ok) {
        // The body can echo the request, so only the status goes into the error.
        throw new Error(`Resend rejected the email with status ${res.status}`);
      }
      const body = (await res.json()) as { id?: string };
      return { id: body.id ?? 'unknown' };
    },
  };
}

/** Picks the adapter from the environment. Switching provider needs no code change (CAP-04). */
export function createEmailAdapter(config: EmailConfig): EmailAdapter {
  switch (config.EMAIL_PROVIDER) {
    case 'smtp':
      if (!config.SMTP_URL) throw new Error('SMTP_URL is required when EMAIL_PROVIDER=smtp');
      return smtpEmailAdapter(config.EMAIL_FROM, config.SMTP_URL);
    case 'resend':
      if (!config.RESEND_API_KEY) {
        throw new Error('RESEND_API_KEY is required when EMAIL_PROVIDER=resend');
      }
      return resendEmailAdapter(config.EMAIL_FROM, config.RESEND_API_KEY);
    case 'console':
      return consoleEmailAdapter(config.EMAIL_FROM);
  }
}
