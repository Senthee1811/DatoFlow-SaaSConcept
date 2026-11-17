'use client';

import type { MyDayDto, TaskDto } from '@datoflow/shared';
import { Card, Halftone } from '@datoflow/ui';
import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { api, problemMessage } from '@/lib/api';
import { useOrg } from '@/lib/org-context';
import { LeadBadges } from '../leads/lead-badges';
import { PageHeader } from '../page-header';
import { TaskItem } from '../tasks/task-item';

/** My day (TASK-05): overdue next steps, then today's, then your stuck leads. */
export default function MyDayPage() {
  const { org } = useOrg();
  const [day, setDay] = useState<MyDayDto | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setDay(await api<MyDayDto>(`/v1/orgs/${org.id}/me/day`));
    } catch (e) {
      setError(problemMessage(e));
    }
  }, [org.id]);

  useEffect(() => {
    void load();
  }, [load]);

  async function done(task: TaskDto) {
    setBusy(task.id);
    try {
      await api(`/v1/orgs/${org.id}/tasks/${task.id}`, {
        method: 'PATCH',
        body: { status: 'DONE' },
      });
      toast(`Done: ${task.title}. Set what happens next on the lead`);
      await load();
    } catch (e) {
      toast(problemMessage(e));
    } finally {
      setBusy(null);
    }
  }

  const empty = day && !day.overdue.length && !day.today.length && !day.stuck.length;
  const dateLabel = day
    ? new Intl.DateTimeFormat('en-GB', {
        weekday: 'long',
        day: 'numeric',
        month: 'long',
        timeZone: 'UTC',
      }).format(new Date(`${day.date}T00:00:00Z`))
    : '';

  return (
    <>
      <PageHeader
        title="My day"
        description={
          day ? `${dateLabel}. Overdue first, then today, then leads that slipped.` : undefined
        }
      />
      {error ? <p role="alert">{error}</p> : null}
      {!day ? (
        error ? null : (
          <p aria-live="polite">Loading your day</p>
        )
      ) : empty ? (
        <Halftone className="p-6 sm:p-10">
          <div className="relative z-10 flex max-w-xl flex-col gap-3 rounded-medium bg-limestone p-6">
            <h2 className="display text-heading">Nothing due today</h2>
            <p>
              No overdue next steps and no stuck leads. Open your leads to plan what comes next.
            </p>
            <Link
              href={`/app/${org.slug}/leads`}
              className="underline decoration-dotted underline-offset-4"
            >
              Open the leads
            </Link>
          </div>
        </Halftone>
      ) : (
        <>
          <DaySection
            id="overdue"
            title="Overdue"
            count={day.overdue.length}
            emptyText="Nothing overdue."
          >
            {day.overdue.map((t) => (
              <TaskItem
                key={t.id}
                task={t}
                slug={org.slug}
                timezone={org.timezone}
                onDone={done}
                busy={busy === t.id}
              />
            ))}
          </DaySection>
          <DaySection
            id="today"
            title="Due today"
            count={day.today.length}
            emptyText="Nothing else due today."
          >
            {day.today.map((t) => (
              <TaskItem
                key={t.id}
                task={t}
                slug={org.slug}
                timezone={org.timezone}
                onDone={done}
                busy={busy === t.id}
              />
            ))}
          </DaySection>
          <DaySection
            id="stuck"
            title="Stuck leads"
            count={day.stuck.length}
            emptyText="None of your leads are stuck."
          >
            {day.stuck.map((lead) => (
              <li key={lead.id} className="flex flex-col gap-1 rounded-medium bg-pumice px-4 py-3">
                <Link
                  href={`/app/${org.slug}/leads/${lead.id}`}
                  className="underline decoration-dotted underline-offset-4"
                >
                  {lead.name}
                </Link>
                {lead.company ? (
                  <span className="text-body-sm text-obsidian/80">{lead.company}</span>
                ) : null}
                <span className="flex flex-wrap gap-1">
                  <LeadBadges lead={lead} />
                </span>
              </li>
            ))}
          </DaySection>
        </>
      )}
    </>
  );
}

function DaySection({
  id,
  title,
  count,
  emptyText,
  children,
}: {
  id: string;
  title: string;
  count: number;
  emptyText: string;
  children: React.ReactNode;
}) {
  return (
    <Card density="dense" aria-labelledby={`${id}-title`} className="flex flex-col gap-4">
      <h2 id={`${id}-title`} className="display text-heading">
        {title} <span className="tabular">({count})</span>
      </h2>
      {count ? (
        <ul aria-label={title} className="flex flex-col gap-2">
          {children}
        </ul>
      ) : (
        <p className="text-body-sm text-obsidian/80">{emptyText}</p>
      )}
    </Card>
  );
}
