'use client';

import { hasFeature } from '@datoflow/domain';
import type { Preferences } from '@datoflow/shared';
import { Button, Card, Divider } from '@datoflow/ui';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { api, problemMessage } from '@/lib/api';
import { authClient } from '@/lib/auth-client';
import { useOrg } from '@/lib/org-context';
import { PageHeader } from '../page-header';

export default function AccountPage() {
  const { me } = useOrg();
  const router = useRouter();
  const [busy, setBusy] = useState<'out' | 'all' | null>(null);

  async function signOut() {
    setBusy('out');
    await authClient.signOut();
    router.replace('/sign-in');
  }

  async function signOutEverywhere() {
    if (!window.confirm('Sign out on every device, including this one?')) return;
    setBusy('all');
    const { error } = await authClient.revokeSessions();
    if (error) {
      toast('Could not sign out other devices. Try again');
      setBusy(null);
      return;
    }
    router.replace('/sign-in');
  }

  return (
    <>
      <PageHeader title="Account" />
      <Card className="flex max-w-2xl flex-col gap-6">
        <div>
          <p className="text-subheading">{me.name}</p>
          <p className="text-obsidian/80">{me.email}</p>
        </div>
        <Divider />
        <div className="flex flex-col gap-3">
          <h2 className="text-body">Sessions</h2>
          <p className="text-body-sm text-obsidian/80">
            Signed in on a shared or lost device? Sign out everywhere and sign in again here.
          </p>
          <div className="flex flex-wrap gap-2">
            <Button variant="secondary" loading={busy === 'all'} onClick={signOutEverywhere}>
              Sign out everywhere
            </Button>
            <Button variant="ghost" loading={busy === 'out'} onClick={signOut}>
              Sign out
            </Button>
          </div>
        </div>
      </Card>
      <ReminderSettings />
    </>
  );
}

type Choices = { reminderEmail: boolean; dailyDigest: boolean };

/** How reminders reach you in this workspace (UF-8). In-app reminders are always on. */
function ReminderSettings() {
  const { org } = useOrg();
  const [choices, setChoices] = useState<Choices | null>(null);
  const emailIncluded = hasFeature(org.planCode, 'emailReminders');

  useEffect(() => {
    api<Preferences>(`/v1/orgs/${org.id}/me/preferences`)
      .then((p) =>
        setChoices({
          reminderEmail: p.notifications?.reminderEmail !== false,
          dailyDigest: p.notifications?.dailyDigest !== false,
        }),
      )
      .catch((e) => toast(problemMessage(e)));
  }, [org.id]);

  async function save(next: Choices) {
    const before = choices;
    setChoices(next);
    try {
      await api(`/v1/orgs/${org.id}/me/preferences`, {
        method: 'PUT',
        body: { notifications: next },
      });
      toast('Reminder settings saved');
    } catch (e) {
      setChoices(before);
      toast(problemMessage(e));
    }
  }

  const options: { key: keyof Choices; label: string; hint: string }[] = [
    {
      key: 'reminderEmail',
      label: 'Email me 15 minutes before a next step',
      hint: 'The in-app reminder always appears under Notifications',
    },
    {
      key: 'dailyDigest',
      label: 'Daily digest at 08:00',
      hint: `Overdue next steps, today's and your stuck leads, at 08:00 ${org.timezone.replaceAll('_', ' ')} time`,
    },
  ];

  return (
    <Card className="flex max-w-2xl flex-col gap-4">
      <div>
        <h2 className="display text-heading">Reminders</h2>
        <p className="mt-2 text-body-sm text-obsidian/80">For {org.name}.</p>
      </div>
      {!emailIncluded ? (
        <p className="rounded-medium bg-sulfur px-5 py-3 text-body-sm">
          Email reminders and the daily digest come with the Starter plan. On Free, reminders appear
          in the app only.
        </p>
      ) : null}
      {choices ? (
        options.map((o) => (
          <label
            key={o.key}
            className="flex min-h-11 cursor-pointer items-start gap-3 rounded-medium bg-pumice px-5 py-4"
          >
            <input
              type="checkbox"
              className="mt-1 size-5 accent-obsidian"
              checked={choices[o.key]}
              disabled={!emailIncluded}
              onChange={(e) => void save({ ...choices, [o.key]: e.target.checked })}
            />
            <span>
              {o.label}
              <span className="block text-body-sm text-obsidian/75">{o.hint}</span>
            </span>
          </label>
        ))
      ) : (
        <p aria-live="polite">Loading your reminder settings</p>
      )}
    </Card>
  );
}
