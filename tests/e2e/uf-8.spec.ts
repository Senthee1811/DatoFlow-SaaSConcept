import { expect, test, type Page } from '@playwright/test';
import { emailText, expectAccessible, inMinutes, newWorkspace, sql } from './support.js';

/**
 * UF-8 A rep's day. My day lists overdue next steps, then today's, then the rep's stuck leads →
 * the rep logs a call from the lead panel → must set the next step before the panel saves, or mark
 * the lead Won or Lost → a reminder fires 15 minutes before a due next step, in-app and by email.
 *
 * The stack runs the reminder job every few seconds in E2E (REMINDER_INTERVAL_SECONDS).
 */

async function post(page: Page, path: string, body: unknown) {
  const res = await page.request.post(path, { data: body });
  expect(res.status(), `${path}: ${await res.text()}`).toBe(201);
  return (await res.json()) as { id: string };
}

test('UF-8: a rep works through My day, logs a call with its next step and is reminded', async ({
  page,
  baseURL,
}) => {
  const { slug, email, orgId } = await newWorkspace(page, baseURL!, 'uf8', { sample: false });
  // Email reminders come with Starter. Billing arrives in Phase 6, so the plan is set directly.
  sql(`UPDATE "Organization" SET "planCode" = 'starter' WHERE id = '${orgId}'`);

  const late = await post(page, `/v1/orgs/${orgId}/leads`, {
    name: 'Amaya Perera',
    company: 'Lotus Dental Care',
  });
  const soon = await post(page, `/v1/orgs/${orgId}/leads`, { name: 'Kasun Silva' });
  const quiet = await post(page, `/v1/orgs/${orgId}/leads`, { name: 'Dilini Fernando' });
  await post(page, `/v1/orgs/${orgId}/tasks`, {
    leadId: late.id,
    title: 'Call back about pricing',
    type: 'CALL',
    dueAt: inMinutes(-120),
  });
  await post(page, `/v1/orgs/${orgId}/tasks`, {
    leadId: soon.id,
    title: 'Send the proposal',
    type: 'EMAIL',
    dueAt: inMinutes(10),
  });
  // Dilini went quiet: no activity for longer than the stage SLA.
  sql(
    `UPDATE "Lead" SET "lastActivityAt" = now() - interval '4 days', "slaDueAt" = now() - interval '1 day' WHERE id = '${quiet.id}'`,
  );

  // My day: overdue first, then today, then stuck leads.
  await page.getByRole('link', { name: 'My day' }).first().click();
  await expect(page.getByRole('heading', { level: 1, name: 'My day' })).toBeVisible();
  const headings = page.getByRole('heading', { level: 2 });
  await expect(headings).toHaveText([/^Overdue/, /^Due today/, /^Stuck leads/]);
  await expect(page.getByRole('list', { name: 'Overdue' })).toContainText(
    'Call back about pricing',
  );
  await expect(page.getByRole('list', { name: 'Due today' })).toContainText('Send the proposal');
  const stuck = page.getByRole('list', { name: 'Stuck leads' });
  // Longest stuck first: Dilini's SLA ran out a day ago, Amaya's step two hours ago.
  await expect(stuck.getByRole('link')).toHaveText(['Dilini Fernando', 'Amaya Perera']);
  await expect(stuck).toContainText('Stuck: next step overdue');
  await expectAccessible(page);

  // Log a call from the lead panel.
  await page.getByRole('link', { name: 'Amaya Perera' }).first().click();
  await expect(page.getByRole('heading', { level: 1, name: 'Amaya Perera' })).toBeVisible();
  await page.getByRole('button', { name: 'Log a touch' }).click();
  const dialog = page.getByRole('dialog', { name: 'Log a touch' });
  await expect(dialog).toBeVisible();
  await dialog.getByLabel('What did you do').selectOption({ label: 'Call' });
  await dialog.getByLabel('What happened').fill('Wants the December start. Budget is approved.');
  // The overdue step is ticked as done with this call.
  await expect(dialog.getByLabel('Call back about pricing')).toBeChecked();
  await expectAccessible(page);

  // Without a next step the panel does not save.
  await dialog.getByRole('button', { name: 'Save touch' }).click();
  await expect(dialog).toBeVisible();
  await expect(dialog.getByLabel('Next step', { exact: true })).toHaveJSProperty(
    'validity.valueMissing',
    true,
  );

  await dialog.getByLabel('Next step', { exact: true }).fill('Send the onboarding plan');
  await dialog.getByLabel('Type').selectOption({ label: 'Email' });
  await dialog.getByRole('button', { name: 'Save touch' }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByText('Call logged. Next step set').first()).toBeVisible();

  const steps = page.getByRole('list', { name: 'Open next steps' });
  await expect(steps).toContainText('Send the onboarding plan');
  await expect(steps).not.toContainText('Call back about pricing');
  const timeline = page.getByRole('list', { name: 'Timeline' });
  await expect(timeline).toContainText('logged a call');
  await expect(timeline).toContainText('Wants the December start');
  await expect(timeline).toContainText('finished: Call back about pricing');
  // With a fresh next step and a fresh touch, Amaya is no longer stuck.
  await expect(page.getByText('Stuck: next step overdue')).toHaveCount(0);

  // The API refuses a touch without a next step, whatever the client does (TASK-02).
  const refused = await page.request.post(`/v1/orgs/${orgId}/leads/${late.id}/activities`, {
    data: { type: 'TOUCH', channel: 'CALL' },
  });
  expect(refused.status()).toBe(422);
  expect((await refused.json()).code).toBe('NEXT_STEP_REQUIRED');

  // The reminder for "Send the proposal" (due in 10 minutes) arrives in-app and by email.
  const bell = page.getByRole('link', { name: /^Notifications, \d+ unread$/ });
  // The bell's count loads after the page does, so give each reload a moment to show it.
  await expect(async () => {
    await page.reload();
    await expect(bell).toBeVisible({ timeout: 5_000 });
  }).toPass({ timeout: 60_000, intervals: [3_000] });
  await bell.click();
  await expect(page.getByRole('heading', { level: 1, name: 'Notifications' })).toBeVisible();
  const list = page.getByRole('list', { name: 'Notifications' });
  await expect(list).toContainText('Send the proposal, Kasun Silva');
  await expectAccessible(page);
  await page.getByRole('button', { name: 'Mark all as read' }).click();
  await expect(page.getByRole('link', { name: 'Notifications', exact: true })).toBeVisible();

  const mail = await emailText(email, /^Due at \d\d:\d\d: Send the proposal$/, 60_000);
  expect(mail).toContain('Your next step is due in 15 minutes.');
  expect(mail).toContain(`/app/${slug}/leads/${soon.id}`);

  // The rep can choose: reminder emails can be turned off.
  await page.goto(`/app/${slug}/account`);
  const choice = page.getByLabel('Email me 15 minutes before a next step');
  await expect(choice).toBeChecked();
  await choice.uncheck();
  await expect(page.getByText('Reminder settings saved').first()).toBeVisible();
  await page.reload();
  await expect(page.getByLabel('Email me 15 minutes before a next step')).not.toBeChecked();
});

test('UF-8: a touch can close the lead as Won instead of setting a next step @mobile', async ({
  page,
  baseURL,
}) => {
  const { orgId, slug } = await newWorkspace(page, baseURL!, 'uf8won', { sample: false });
  const lead = await post(page, `/v1/orgs/${orgId}/leads`, {
    name: 'Ruwan Silva',
    dealValue: 450000,
  });
  await page.goto(`/app/${slug}/leads/${lead.id}`);
  await expect(
    page.getByText('No next step yet. Every open lead needs one with a date.'),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Log a touch' }).click();
  const dialog = page.getByRole('dialog', { name: 'Log a touch' });
  await dialog.getByLabel('What did you do').selectOption({ label: 'Meeting' });
  await dialog.getByText('Mark as won').click();
  await expect(dialog.getByLabel(/^Deal value/)).toHaveValue('450000');
  await dialog.getByRole('button', { name: 'Save touch' }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByText('Meeting logged. Lead marked won').first()).toBeVisible();
  await expect(page.getByText('The lead is closed and needs no next step.')).toBeVisible();
});
