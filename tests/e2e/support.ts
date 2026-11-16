import AxeBuilder from '@axe-core/playwright';
import { expect, type Page } from '@playwright/test';

const MAILPIT = process.env.MAILPIT_URL ?? 'http://localhost:8025';
export const PASSWORD = 'correct-horse-battery';

export function uniqueEmail(label: string) {
  return `${label}.${Date.now().toString(36)}${Math.floor(Math.random() * 1e4)}@example.test`;
}

interface MailSummary {
  ID: string;
  Subject: string;
  To: { Address: string }[];
}

/** Waits for an email to `to` whose subject matches, and returns its text. */
export async function emailText(to: string, subject: RegExp, timeoutMs = 20_000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const res = await fetch(`${MAILPIT}/api/v1/search?query=${encodeURIComponent(`to:"${to}"`)}`);
    const { messages } = (await res.json()) as { messages: MailSummary[] };
    const hit = messages.find((m) => subject.test(m.Subject));
    if (hit) {
      const message = (await (await fetch(`${MAILPIT}/api/v1/message/${hit.ID}`)).json()) as {
        Text: string;
      };
      return message.Text;
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`No email to ${to} matching ${subject}`);
}

/** The first link in the newest matching email. */
export async function linkFromEmail(to: string, subject: RegExp): Promise<string> {
  const link = (await emailText(to, subject)).match(/https?:\/\/\S+/)?.[0];
  if (!link) throw new Error(`The email to ${to} matching ${subject} has no link`);
  return link;
}

export async function hasEmail(to: string, subject: RegExp): Promise<boolean> {
  return emailText(to, subject).then(
    () => true,
    () => false,
  );
}

/** Links in emails use APP_URL. The browser follows them at the base URL under test. */
export function local(link: string, baseURL: string) {
  const url = new URL(link);
  return new URL(url.pathname + url.search, baseURL).toString();
}

/** WCAG 2.2 AA checks with axe (NFR-A11Y-01). */
export async function expectAccessible(page: Page) {
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
    .analyze();
  expect(
    results.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`),
  ).toEqual([]);
}

/** Signs up through the UI and follows the verification link. Ends signed in at `expectedPath`. */
export async function signUpThroughUi(page: Page, baseURL: string, name: string, email: string) {
  await page.getByLabel('Your name').fill(name);
  await page.getByLabel('Work email').fill(email);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Create account' }).click();
  await expect(page.getByRole('heading', { name: 'Check your email' })).toBeVisible();
  const link = await linkFromEmail(email, /Confirm your email/);
  await page.goto(local(link, baseURL));
}
