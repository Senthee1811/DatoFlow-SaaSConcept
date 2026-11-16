import { expect, test } from '@playwright/test';
import {
  expectAccessible,
  hasEmail,
  linkFromEmail,
  local,
  signUpThroughUi,
  uniqueEmail,
} from './support.js';

test('UF-4: invite a teammate', async ({ browser, baseURL }) => {
  const base = baseURL!;
  const ownerEmail = uniqueEmail('owner');
  const repEmail = uniqueEmail('rep');
  const slug = `northwind-${Date.now().toString(36)}`;

  // The Owner signs up, verifies and creates a workspace.
  const ownerContext = await browser.newContext();
  const owner = await ownerContext.newPage();
  await owner.goto('/sign-up');
  await expectAccessible(owner);
  await signUpThroughUi(owner, base, 'Ruwani Perera', ownerEmail);
  await expect(owner).toHaveURL(/\/app\/new$/);
  await owner.getByLabel('Agency or team name').fill('Northwind Leads');
  await owner.getByLabel('Workspace address').fill(slug);
  await expectAccessible(owner);
  await owner.getByRole('button', { name: 'Create workspace' }).click();
  await expect(owner).toHaveURL(new RegExp(`/app/${slug}$`));
  await expect(owner.getByRole('heading', { level: 1, name: 'Northwind Leads' })).toBeVisible();

  // Owner or Admin enters an email and a role.
  await owner.getByRole('link', { name: 'Members' }).first().click();
  await expect(owner.getByRole('heading', { level: 1, name: 'Members' })).toBeVisible();
  await expectAccessible(owner);
  await owner.getByLabel('Email').fill(repEmail);
  await owner.getByLabel('Role', { exact: true }).selectOption('REP');
  await owner.getByRole('button', { name: 'Send invite' }).click();
  await expect(owner.getByText(`Invitation sent to ${repEmail}`)).toBeVisible();
  await expect(
    owner.getByRole('list', { name: 'Open invitations' }).getByText(repEmail),
  ).toBeVisible();

  // Seat entitlement: Free has 2 users, so a second open invitation is refused with the limit named.
  await owner.getByLabel('Email').fill(uniqueEmail('third'));
  await owner.getByRole('button', { name: 'Send invite' }).click();
  await expect(
    owner.getByRole('alert').filter({ hasText: 'Your plan includes 2 users' }),
  ).toBeVisible();

  // The invitee opens the email and signs up from the invitation.
  const inviteLink = local(await linkFromEmail(repEmail, /invited you to Northwind Leads/), base);
  const repContext = await browser.newContext();
  const rep = await repContext.newPage();
  await rep.goto(inviteLink);
  await expect(rep.getByRole('heading', { name: 'Join Northwind Leads' })).toBeVisible();
  await expect(rep.getByText('Sales Rep')).toBeVisible();
  await expectAccessible(rep);
  await rep.getByRole('link', { name: 'Create account' }).click();
  await expect(rep.getByLabel('Work email')).toHaveValue(repEmail);
  await signUpThroughUi(rep, base, 'Kasun Silva', repEmail);

  // Token valid, unused and matching the email: membership created.
  await expect(rep).toHaveURL(/\/invite\//);
  await rep.getByRole('button', { name: 'Accept and join' }).click();
  await expect(rep).toHaveURL(new RegExp(`/app/${slug}$`));
  await expect(rep.getByText('Northwind Leads · Sales Rep')).toBeVisible();
  // A Rep does not see member management.
  await expect(rep.getByRole('link', { name: 'Members' })).toHaveCount(0);

  // The inviter is notified, and the join is audit-logged.
  expect(await hasEmail(ownerEmail, /Kasun Silva joined Northwind Leads/)).toBe(true);
  await owner.reload();
  await expect(
    owner.getByRole('list', { name: 'Members' }).getByText('Kasun Silva', { exact: true }),
  ).toBeVisible();
  await owner.getByRole('link', { name: 'Audit log' }).first().click();
  await expect(owner.getByText('accepted an invitation')).toBeVisible();
  await expect(owner.getByText('sent an invitation')).toBeVisible();
  await expectAccessible(owner);

  // No: the used link shows a clear screen with "Ask for a new invite".
  const strangerContext = await browser.newContext();
  const stranger = await strangerContext.newPage();
  await stranger.goto(inviteLink);
  await expect(stranger.getByRole('heading', { name: 'Ask for a new invite' })).toBeVisible();
  await expect(stranger.getByText('This invitation was already used')).toBeVisible();
  await expectAccessible(stranger);

  await Promise.all([ownerContext.close(), repContext.close(), strangerContext.close()]);
});

test('UF-4: an invitation for another address explains how to get a new one @mobile', async ({
  browser,
  baseURL,
}) => {
  const base = baseURL!;
  const ownerEmail = uniqueEmail('owner2');
  const intended = uniqueEmail('intended');
  const slug = `harbor-${Date.now().toString(36)}`;

  const ownerContext = await browser.newContext();
  const owner = await ownerContext.newPage();
  await owner.goto('/sign-up');
  await signUpThroughUi(owner, base, 'Dilani Owner', ownerEmail);
  await owner.getByLabel('Agency or team name').fill('Harbor Growth');
  await owner.getByLabel('Workspace address').fill(slug);
  await owner.getByRole('button', { name: 'Create workspace' }).click();
  await expect(owner).toHaveURL(new RegExp(`/app/${slug}$`));
  await owner.goto(`/app/${slug}/members`);
  await owner.getByLabel('Email').fill(intended);
  await owner.getByRole('button', { name: 'Send invite' }).click();
  await expect(owner.getByText(`Invitation sent to ${intended}`)).toBeVisible();
  const inviteLink = local(await linkFromEmail(intended, /invited you/), base);

  // Someone else, signed in with a different address, opens the link.
  const otherContext = await browser.newContext();
  const other = await otherContext.newPage();
  await other.goto('/sign-up');
  const otherEmail = uniqueEmail('other');
  await signUpThroughUi(other, base, 'Other Person', otherEmail);
  await other.goto(inviteLink);
  await expect(
    other.getByRole('alert').filter({ hasText: `You are signed in as ${otherEmail}` }),
  ).toBeVisible();
  await expect(other.getByRole('button', { name: 'Accept and join' })).toHaveCount(0);
  await expectAccessible(other);

  await Promise.all([ownerContext.close(), otherContext.close()]);
});
