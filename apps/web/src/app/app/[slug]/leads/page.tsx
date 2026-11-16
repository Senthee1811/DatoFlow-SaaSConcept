'use client';

import { can } from '@datoflow/domain';
import type { LeadFilters, Preferences } from '@datoflow/shared';
import { buttonClass, cn } from '@datoflow/ui';
import { Columns3, Plus, Rows3 } from 'lucide-react';
import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import { api } from '@/lib/api';
import { useLookups } from '@/lib/lookups';
import { useOrg } from '@/lib/org-context';
import { PageHeader } from '../page-header';
import { FilterBar } from './filters';
import { LeadBoard } from './lead-board';
import { LeadTable } from './lead-table';

type View = 'table' | 'board';

export default function LeadsPage() {
  const { org } = useOrg();
  const { lookups, error } = useLookups(org.id);
  const [prefs, setPrefs] = useState<{ filters: LeadFilters; view: View } | null>(null);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  // Filters and the chosen view persist per user (LEAD-05).
  useEffect(() => {
    api<Preferences>(`/v1/orgs/${org.id}/me/preferences`)
      .then((p) => setPrefs({ filters: p.leadFilters ?? {}, view: p.leadView ?? 'board' }))
      .catch(() => setPrefs({ filters: {}, view: 'board' }));
  }, [org.id]);

  function update(next: { filters: LeadFilters; view: View }) {
    setPrefs(next);
    clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => {
      void api(`/v1/orgs/${org.id}/me/preferences`, {
        method: 'PUT',
        body: { leadFilters: clean(next.filters), leadView: next.view },
      }).catch(() => undefined);
    }, 400);
  }

  const views: { id: View; label: string; icon: typeof Rows3 }[] = [
    { id: 'board', label: 'Board', icon: Columns3 },
    { id: 'table', label: 'Table', icon: Rows3 },
  ];

  return (
    <>
      <PageHeader
        title="Leads"
        actions={
          <div className="flex flex-wrap items-center gap-2">
            {prefs ? (
              <div role="group" aria-label="View" className="flex rounded-pills bg-limestone p-1">
                {views.map(({ id, label, icon: Icon }) => (
                  <button
                    key={id}
                    type="button"
                    aria-pressed={prefs.view === id}
                    onClick={() => update({ ...prefs, view: id })}
                    className={cn(
                      buttonClass('ghost', 'sm'),
                      prefs.view === id && 'bg-obsidian text-chalk hover:bg-obsidian',
                    )}
                  >
                    <Icon aria-hidden className="size-4" strokeWidth={1.75} />
                    {label}
                  </button>
                ))}
              </div>
            ) : null}
            <Link href={`/app/${org.slug}/leads/new`} className={buttonClass('primary')}>
              <Plus aria-hidden className="size-4" strokeWidth={1.75} />
              New lead
            </Link>
          </div>
        }
      />
      {error ? <p role="alert">{error}</p> : null}
      {!lookups || !prefs ? (
        <p aria-live="polite" className="px-2">
          Loading leads
        </p>
      ) : (
        <>
          <FilterBar
            filters={prefs.filters}
            onChange={(filters) => update({ ...prefs, filters })}
            lookups={lookups}
            showStage={prefs.view === 'table'}
            canSeeArchived={can(org.role, 'leads.archive')}
          />
          {prefs.view === 'board' ? (
            <LeadBoard
              orgId={org.id}
              slug={org.slug}
              filters={prefs.filters}
              lookups={lookups}
              currency={org.currency}
              wonRequiresDealValue={org.settings.wonRequiresDealValue ?? true}
            />
          ) : (
            <LeadTable
              orgId={org.id}
              slug={org.slug}
              timezone={org.timezone}
              filters={prefs.filters}
              onSort={(sort) => update({ ...prefs, filters: { ...prefs.filters, sort } })}
              lookups={lookups}
            />
          )}
        </>
      )}
    </>
  );
}

function clean(filters: LeadFilters): LeadFilters {
  return Object.fromEntries(
    Object.entries(filters).filter(
      ([, v]) => v !== undefined && v !== '' && !(Array.isArray(v) && v.length === 0),
    ),
  ) as LeadFilters;
}
