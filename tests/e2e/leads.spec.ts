import { expect, test, type Page } from '@playwright/test';
import { expectAccessible, signUpThroughUi, uniqueEmail } from './support.js';

/** Signs up, creates a workspace with the sample agency and opens the leads board. */
async function workspaceWithSample(page: Page, baseURL: string, label: string) {
  const slug = `${label}-${Date.now().toString(36)}`;
  await page.goto('/sign-up');
  await signUpThroughUi(page, baseURL, 'Ruwani Perera', uniqueEmail(label));
  await page.getByLabel('Agency or team name').fill('Northwind Leads');
  await page.getByLabel('Workspace address').fill(slug);
  await expect(page.getByLabel('Start with sample data')).toBeChecked();
  await page.getByRole('button', { name: 'Create workspace' }).click();
  await expect(page).toHaveURL(new RegExp(`/app/${slug}$`));
  return slug;
}

const column = (page: Page, stage: string) => page.getByRole('region', { name: `${stage} stage` });

async function openBoard(page: Page, slug: string) {
  await page.goto(`/app/${slug}/leads`);
  await page.getByRole('button', { name: 'Board' }).click();
  await expect(column(page, 'New').getByRole('listitem').first()).toBeVisible();
}

test('PIPE-02: drag a card to another stage on the board', async ({ page, baseURL }) => {
  const slug = await workspaceWithSample(page, baseURL!, 'drag');
  await openBoard(page, slug);
  await expectAccessible(page);

  const card = column(page, 'New').getByRole('listitem').first();
  const name = (await card.getByRole('link').textContent())!;
  const target = column(page, 'Contacted');
  const from = (await card.boundingBox())!;
  const to = (await target.boundingBox())!;
  await page.mouse.move(from.x + from.width / 2, from.y + 20);
  await page.mouse.down();
  await page.mouse.move(from.x + from.width / 2 + 20, from.y + 30, { steps: 5 });
  await page.mouse.move(to.x + to.width / 2, to.y + 120, { steps: 15 });
  await page.mouse.up();

  await expect(target.getByRole('link', { name, exact: true })).toBeVisible();
  await page.reload();
  await page.getByRole('button', { name: 'Board' }).click();
  await expect(column(page, 'Contacted').getByRole('link', { name, exact: true })).toBeVisible();
});

test('PIPE-02: keyboard moves work on the board, and an API error rolls back with a toast', async ({
  page,
  baseURL,
}) => {
  const slug = await workspaceWithSample(page, baseURL!, 'keys');
  await openBoard(page, slug);

  // Space picks up, the right arrow chooses the next stage, Space drops.
  const handle = column(page, 'New')
    .getByRole('button', { name: /^Move / })
    .first();
  const name = ((await handle.textContent()) ?? '').replace(/^Move /, '');
  await handle.focus();
  await page.keyboard.press('Space');
  await expect(page.getByText(`Picked up ${name}`)).toBeAttached();
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('Space');
  await expect(column(page, 'Contacted').getByRole('link', { name, exact: true })).toBeVisible();
  // Focus follows the card, so the next move needs no mouse.
  await expect(page.locator(':focus')).toHaveAttribute('data-move-handle', /.+/);

  // The API refuses the next move: the card returns and a toast says why.
  await page.route('**/v1/orgs/*/leads/*', (route) =>
    route.request().method() === 'PATCH'
      ? route.fulfill({
          status: 500,
          contentType: 'application/problem+json',
          body: JSON.stringify({
            status: 500,
            title: 'Something went wrong',
            code: 'INTERNAL',
            detail: 'Try again',
          }),
        })
      : route.continue(),
  );
  await page.keyboard.press('Space');
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('Space');
  await expect(page.getByText(`${name} could not move`).first()).toBeVisible();
  await expect(column(page, 'Contacted').getByRole('link', { name, exact: true })).toBeVisible();
  await expect(column(page, 'Qualified').getByRole('link', { name, exact: true })).toHaveCount(0);
  await page.unroute('**/v1/orgs/*/leads/*');

  // Escape cancels a pick-up.
  await page.keyboard.press('Space');
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('Escape');
  await expect(page.getByText('Move cancelled')).toBeAttached();
  await expect(column(page, 'Contacted').getByRole('link', { name, exact: true })).toBeVisible();
});

test('PIPE-03: moving to Lost asks for a loss reason first', async ({ page, baseURL }) => {
  const slug = await workspaceWithSample(page, baseURL!, 'lost');
  await openBoard(page, slug);
  const handle = column(page, 'Proposal')
    .getByRole('button', { name: /^Move / })
    .first();
  const name = ((await handle.textContent()) ?? '').replace(/^Move /, '');
  await handle.focus();
  await page.keyboard.press('Space');
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('Space');
  const dialog = page.getByRole('dialog', { name: 'Why was it lost' });
  await expect(dialog).toBeVisible();
  await expectAccessible(page);
  await dialog.getByLabel('Loss reason').selectOption({ label: 'Chose a competitor' });
  await dialog.getByRole('button', { name: 'Mark as lost' }).click();
  await expect(column(page, 'Lost').getByRole('link', { name, exact: true })).toBeVisible();
});

test('LEAD-05: table filters persist across reloads', async ({ page, baseURL }) => {
  const slug = await workspaceWithSample(page, baseURL!, 'filters');
  await page.goto(`/app/${slug}/leads`);
  await page.getByRole('button', { name: 'Table' }).click();
  await expect(page.getByRole('table')).toBeVisible();
  await page.getByRole('button', { name: /^Filters/ }).click();
  await page.getByLabel('Source').selectOption({ label: 'Referral' });
  await page.getByLabel('Stuck only').check();
  // Every row left is a Referral, once the table has settled on the new filters.
  await expect
    .poll(async () => {
      const sources = await page.locator('tbody td:nth-child(4)').allTextContents();
      return sources.length > 0 && sources.every((t) => t === 'Referral');
    })
    .toBe(true);
  await expectAccessible(page);
  await page.waitForTimeout(700);
  await page.reload();
  await expect(page.getByRole('button', { name: 'Table' })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByRole('button', { name: /^Filters · 1/ })).toBeVisible();
  await page.getByRole('button', { name: /^Filters/ }).click();
  await expect(page.getByLabel('Source')).toHaveValue('REFERRAL');
  await expect(page.getByLabel('Stuck only')).toBeChecked();
});

test('LEAD-03 and ORG-04: a duplicate is flagged, and deleting sample data keeps real leads', async ({
  page,
  baseURL,
}) => {
  const slug = await workspaceWithSample(page, baseURL!, 'sample');
  const realEmail = uniqueEmail('client');
  for (const name of ['Real Client', 'Real Client Again']) {
    await page.goto(`/app/${slug}/leads/new`);
    await page.getByLabel('Name', { exact: true }).fill(name);
    await page.getByLabel('Email').fill(realEmail.toUpperCase());
    await page.getByRole('button', { name: 'Add lead' }).click();
    await expect(page.getByRole('heading', { level: 1, name })).toBeVisible();
  }
  const notice = page.getByRole('region', { name: 'Possible duplicate' });
  await expect(notice.getByRole('link', { name: 'Real Client' })).toBeVisible();
  await expectAccessible(page);

  await page.goto(`/app/${slug}/settings`);
  page.once('dialog', (d) => void d.accept());
  await page.getByRole('button', { name: 'Delete sample data' }).click();
  await expect(page.getByText('Sample data deleted: 60 leads and 3 reps')).toBeVisible();

  await page.goto(`/app/${slug}/leads`);
  await page.getByRole('button', { name: 'Table' }).click();
  const rows = page.getByRole('table').getByRole('row');
  await expect(rows).toHaveCount(3);
  await expect(
    page.getByRole('table').getByRole('link', { name: 'Real Client', exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole('table').getByRole('link', { name: 'Real Client Again' }),
  ).toBeVisible();
});
