import { expect, test, type Page } from '@playwright/test';
import { expectAccessible, newWorkspace, sql } from './support.js';

/**
 * UF-3 Automation run. Event in the outbox → first run for this (version, event)? → workflow
 * active? → depth and plan cap → conditions true? No: SKIPPED → actions in order → SUCCEEDED, or
 * a failure that is not retryable: DEAD, Admins notified, manual retry available.
 */

async function post(page: Page, path: string, body: unknown, status = 201) {
  const res = await page.request.post(path, { data: body });
  expect(res.status(), `${path}: ${await res.text()}`).toBe(status);
  return (await res.json()) as { id: string };
}

test('UF-3: a workflow built in the UI runs, skips, goes DEAD with Admins notified, and is retried', async ({
  page,
  baseURL,
}) => {
  const { slug, orgId } = await newWorkspace(page, baseURL!, 'uf3', { sample: false });
  // Starter allows 5 active workflows. Billing arrives in Phase 6, so the plan is set directly.
  sql(`UPDATE "Organization" SET "planCode" = 'starter' WHERE id = '${orgId}'`);

  // Build: when a website lead is created, create a call task and notify the owner.
  await page.getByRole('link', { name: 'Workflows' }).first().click();
  await expect(page.getByRole('heading', { level: 1, name: 'Workflows' })).toBeVisible();
  await expect(page.getByText('No workflows yet')).toBeVisible();
  await expectAccessible(page);
  await page.getByRole('link', { name: 'New workflow' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'New workflow' })).toBeVisible();
  await page.getByLabel('Workflow name').fill('Website leads');
  await expect(page.getByLabel('Trigger', { exact: true })).toHaveValue('lead.created');
  await page.getByRole('button', { name: 'Add a condition' }).click();
  await expect(page.getByLabel('Condition 1', { exact: true })).toHaveValue('source');
  await page.getByLabel('Value', { exact: true }).selectOption({ label: 'Website' });
  await expect(page.getByLabel('Action 1', { exact: true })).toHaveValue('create_task');
  await page.getByLabel('Task', { exact: true }).fill('Call the new lead');
  await page.getByRole('button', { name: 'Add an action' }).click();
  await page
    .getByLabel('Action 2', { exact: true })
    .selectOption({ label: 'Send an internal notification' });
  await page.getByLabel('Message', { exact: true }).fill('New website lead: {{lead.name}}');
  await expectAccessible(page);
  await page.getByRole('button', { name: 'Create workflow' }).click();

  await expect(page.getByRole('heading', { level: 1, name: 'Website leads' })).toBeVisible();
  await expect(page.getByText('Draft', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Activate' }).click();
  await expect(page.getByText('Workflow active with version 1').first()).toBeVisible();
  await expect(page.getByText('Active', { exact: true })).toBeVisible();
  await expectAccessible(page);
  const workflowUrl = page.url();

  // A matching lead runs it; a lead from another source is skipped.
  const web = await post(page, `/v1/orgs/${orgId}/leads`, {
    name: 'Amaya Perera',
    source: 'WEBSITE',
  });
  await post(page, `/v1/orgs/${orgId}/leads`, { name: 'Kasun Silva', source: 'REFERRAL' });

  await page.getByRole('link', { name: 'All runs' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Run log' })).toBeVisible();
  const runs = page.getByRole('list', { name: 'Runs' });
  await expect(async () => {
    await page.reload();
    await expect(runs.getByRole('listitem')).toHaveCount(2, { timeout: 2_000 });
    await expect(runs.getByRole('listitem').filter({ hasText: 'Amaya Perera' })).toContainText(
      'Succeeded',
      { timeout: 2_000 },
    );
  }).toPass({ timeout: 30_000, intervals: [1_000] });
  await expect(runs.getByRole('listitem').filter({ hasText: 'Kasun Silva' })).toContainText(
    'Skipped: the conditions were not met',
  );
  await expectAccessible(page);

  await runs
    .getByRole('listitem')
    .filter({ hasText: 'Amaya Perera' })
    .getByRole('link', { name: 'Website leads' })
    .click();
  const steps = page.getByRole('list', { name: 'Steps' });
  await expect(steps.getByRole('listitem')).toHaveCount(2);
  await expect(steps.getByText('Done')).toHaveCount(2);
  await expect(steps).toContainText('Create a call task "Call the new lead" for the lead owner');
  await expectAccessible(page);

  // The lead shows what the workflow did, under its name.
  await page.getByRole('link', { name: 'Amaya Perera' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Amaya Perera' })).toBeVisible();
  const timeline = page.getByRole('list', { name: 'Timeline' });
  await expect(timeline).toContainText('Workflow: Website leads');
  await expect(timeline).toContainText('set a next step: Call the new lead');
  expect(web.id).toBeTruthy();

  // A failure that is not retryable: the lead has no email address. The run is DEAD at once.
  const welcome = await post(page, `/v1/orgs/${orgId}/workflows`, {
    name: 'Welcome email',
    definition: {
      trigger: 'lead.created',
      conditions: [{ field: 'source', operator: 'is', values: ['EVENT'] }],
      actions: [
        {
          type: 'send_email',
          to: 'lead',
          subject: 'Good to meet you, {{lead.name}}',
          body: 'Thanks for stopping by our stand.',
          delayMinutes: 0,
        },
      ],
    },
  });
  await post(page, `/v1/orgs/${orgId}/workflows/${welcome.id}/activate`, {}, 200);
  const noEmail = await post(page, `/v1/orgs/${orgId}/leads`, {
    name: 'Dilini Fernando',
    source: 'EVENT',
  });

  // The Owner is told, in the notification centre. The first workflow's own message may arrive
  // first, so wait for this one in particular.
  const bell = page.getByRole('link', { name: /^Notifications, \d+ unread$/ });
  const list = page.getByRole('list', { name: 'Notifications' });
  await expect(async () => {
    await page.goto(`/app/${slug}/leads`);
    await bell.click({ timeout: 5_000 });
    await expect(list).toContainText(
      'Workflow “Welcome email” gave up on Dilini Fernando: The lead has no email address',
      { timeout: 2_000 },
    );
  }).toPass({ timeout: 60_000, intervals: [2_000] });
  await list.getByRole('link', { name: 'See the run and retry' }).click();

  await expect(page.getByRole('heading', { level: 1, name: 'Welcome email' })).toBeVisible();
  await expect(page.getByText('Dead', { exact: true })).toBeVisible();
  await expect(page.getByText('Step 1 (send_email): The lead has no email address')).toBeVisible();
  await expectAccessible(page);

  // Fix the cause, then retry by hand.
  const fixed = await page.request.patch(`/v1/orgs/${orgId}/leads/${noEmail.id}`, {
    data: { email: 'dilini@lotusdental.lk' },
  });
  expect(fixed.status()).toBe(200);
  await page.getByRole('button', { name: 'Retry' }).click();
  await expect(page.getByText('Run queued again').first()).toBeVisible();
  await expect(page.getByText('Succeeded', { exact: true })).toBeVisible({ timeout: 30_000 });
  await expect(page.getByRole('button', { name: 'Retry' })).toHaveCount(0);

  // Pause the first workflow.
  await page.goto(workflowUrl);
  await page.getByRole('button', { name: 'Pause' }).click();
  await expect(page.getByText('Workflow paused').first()).toBeVisible();
  await expect(page.getByText('Paused', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Resume' })).toBeVisible();
  await page.goto(`/app/${slug}/workflows`);
  await expect(
    page
      .getByRole('list', { name: 'Workflows' })
      .getByRole('listitem')
      .filter({ hasText: 'Website leads' }),
  ).toContainText('Paused');
});
