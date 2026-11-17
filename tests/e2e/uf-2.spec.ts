import { expect, test, type Page } from '@playwright/test';
import { expectAccessible, newWorkspace, sql } from './support.js';

/**
 * UF-2 Lead lifecycle. A lead moves through the open stages and closes as Won (deal value) or Lost
 * (loss reason) from any open stage. The radar checks every open lead on each change and every
 * 5 minutes (every few seconds in E2E); flagged leads go to the top of My day, and a manager can
 * reassign them.
 */

async function addLead(page: Page, slug: string, name: string, dealValue?: string) {
  await page.goto(`/app/${slug}/leads/new`);
  await page.getByLabel('Name', { exact: true }).fill(name);
  if (dealValue) await page.getByLabel(/^Deal value/).fill(dealValue);
  await page.getByRole('button', { name: 'Add lead' }).click();
  await expect(page.getByRole('heading', { level: 1, name })).toBeVisible();
  return page.url().split('/leads/')[1]!;
}

const stageSelect = (page: Page) => page.getByLabel('Stage', { exact: true });

test('UF-2: a lead moves through the open stages and closes as Won or Lost', async ({
  page,
  baseURL,
}) => {
  const { slug } = await newWorkspace(page, baseURL!, 'uf2', { sample: true });

  await addLead(page, slug, 'Malsha Herath', '380000');
  for (const stage of ['Contacted', 'Qualified', 'Proposal']) {
    await stageSelect(page).selectOption({ label: stage });
    await expect(page.getByText(`Moved to ${stage}`).first()).toBeVisible();
    await expect(stageSelect(page)).toHaveValue(/.+/);
  }
  await stageSelect(page).selectOption({ label: 'Won' });
  await expect(page.getByText('Moved to Won').first()).toBeVisible();
  await expect(page.getByText('The lead is closed and needs no next step.')).toBeVisible();

  // Lost, straight from the first open stage, asks for its reason.
  await addLead(page, slug, 'Gayan Rathnayake');
  await stageSelect(page).selectOption({ label: 'Lost' });
  const dialog = page.getByRole('dialog', { name: 'Why was it lost' });
  await dialog.getByLabel('Loss reason').selectOption({ label: 'No budget' });
  await dialog.getByRole('button', { name: 'Mark as lost' }).click();
  await expect(page.getByText('Moved to Lost').first()).toBeVisible();
  const timeline = page.getByRole('list', { name: 'Timeline' });
  await expect(timeline).toContainText('moved it from New to Lost');
});

test('UF-2: the radar flags stuck leads on change and on its sweep; a manager reassigns one', async ({
  page,
  baseURL,
}) => {
  const { slug } = await newWorkspace(page, baseURL!, 'uf2r', { sample: true });

  // On change: a next step dated in the past makes the lead stuck at once.
  const lateId = await addLead(page, slug, 'Nethmi Bandara');
  await page.getByRole('button', { name: 'Add a next step without a touch' }).click();
  await page.getByLabel('Next step', { exact: true }).fill('Confirm the meeting time');
  const due = page.getByLabel('Due');
  const value = await due.inputValue();
  // Two days ago, same time.
  const [d, t] = value.split('T');
  const day = new Date(`${d}T00:00:00Z`);
  day.setUTCDate(day.getUTCDate() - 2);
  await due.fill(`${day.toISOString().slice(0, 10)}T${t}`);
  await page.getByRole('button', { name: 'Add next step' }).click();
  await expect(page.getByText('Next step set').first()).toBeVisible();
  await expect(page.getByText('Stuck: next step overdue').first()).toBeVisible();
  await expect(page.getByRole('list', { name: 'Timeline' })).toContainText(
    'flagged it as stuck: its next step is overdue',
  );

  // On the sweep: a lead that went quiet, with nothing changed in the app. Its SLA ran out an
  // hour ago, after Nethmi's step (yesterday 10:00), so Nethmi stays the longest stuck.
  const quietId = await addLead(page, slug, 'Lahiru Dissanayake');
  sql(
    `UPDATE "Lead" SET "lastActivityAt" = now() - interval '5 days', "slaDueAt" = now() - interval '1 hour' WHERE id = '${quietId}'`,
  );
  await expect
    .poll(
      async () =>
        sql(`SELECT count(*) FROM "LeadActivity" WHERE "leadId" = '${quietId}' AND type = 'STUCK'`),
      { timeout: 60_000, intervals: [2_000] },
    )
    .toBe('1');
  await page.reload();
  await expect(page.getByText('Stuck: no activity', { exact: true }).first()).toBeVisible();
  await expect(page.getByRole('list', { name: 'Timeline' })).toContainText(
    'Stuck-lead radar flagged it as stuck: no activity within the stage SLA',
  );

  // Flagged leads rise to the top of My day: the longest stuck first.
  await page.goto(`/app/${slug}/day`);
  const stuck = page.getByRole('list', { name: 'Stuck leads' });
  await expect(stuck.getByRole('link')).toHaveText(['Nethmi Bandara', 'Lahiru Dissanayake']);
  await expectAccessible(page);

  // The stuck filter on the leads table finds them.
  await page.goto(`/app/${slug}/leads`);
  await page.getByRole('button', { name: 'Table' }).click();
  await page.getByLabel('Stuck only').check();
  await page.getByRole('searchbox').fill('Lahiru');
  await expect(
    page.getByRole('table').getByRole('link', { name: 'Lahiru Dissanayake' }),
  ).toBeVisible();

  // The Owner (a manager in the role table) reassigns the stuck lead to a rep.
  await page.goto(`/app/${slug}/leads/${quietId}`);
  await page.getByLabel('Owner').selectOption({ label: 'Nadeesha Fernando' });
  await expect(page.getByText('Assigned to Nadeesha Fernando').first()).toBeVisible();
  // Reassigning counts as follow-up: the SLA clock restarts and the flag clears.
  await expect(page.getByText('Stuck: no activity', { exact: true })).toHaveCount(0);
  expect(sql(`SELECT "stuckAt" IS NULL FROM "Lead" WHERE id = '${quietId}'`)).toBe('t');
  expect(lateId).toBeTruthy();
});
