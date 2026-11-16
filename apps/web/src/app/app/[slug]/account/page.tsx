'use client';

import { Button, Card, Divider } from '@datoflow/ui';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { toast } from 'sonner';
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
    </>
  );
}
