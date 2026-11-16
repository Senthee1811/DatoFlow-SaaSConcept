'use client';

import type { OrgDto } from '@datoflow/shared';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { api, problemMessage } from '@/lib/api';
import type { Me } from '@/lib/org-context';

/** Opens the active workspace, the first one, or onboarding when there is none. */
export default function AppEntry() {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      try {
        const [me, orgs] = await Promise.all([
          api<Me>('/v1/me'),
          api<{ items: OrgDto[] }>('/v1/orgs'),
        ]);
        const target = orgs.items.find((o) => o.id === me.activeOrganizationId) ?? orgs.items[0];
        router.replace(target ? `/app/${target.slug}` : '/app/new');
      } catch (e) {
        if ((e as { status?: number }).status === 401) router.replace('/sign-in?next=/app');
        else setError(problemMessage(e));
      }
    })();
  }, [router]);

  return (
    <main className="grid min-h-dvh place-items-center p-6">
      <p aria-live="polite">{error ?? 'Opening your workspace'}</p>
    </main>
  );
}
