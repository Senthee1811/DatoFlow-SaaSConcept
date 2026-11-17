'use client';

import type { Page, WorkflowSummaryDto } from '@datoflow/shared';
import { Badge, Button, buttonClass, Card } from '@datoflow/ui';
import { Plus } from 'lucide-react';
import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { api, problemMessage } from '@/lib/api';
import { formatInOrgTime, useOrg } from '@/lib/org-context';
import { PageHeader } from '../page-header';
import { TRIGGER_LABEL, WorkflowStatus } from './labels';
import { WorkflowsNav } from './workflows-nav';

/** The workflows of an organization (WF-01, WF-05). */
export default function WorkflowsPage() {
  const { org } = useOrg();
  const [items, setItems] = useState<WorkflowSummaryDto[] | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const base = `/app/${org.slug}/workflows`;

  const load = useCallback(
    async (after: string | null) => {
      try {
        const page = await api<Page<WorkflowSummaryDto>>(
          `/v1/orgs/${org.id}/workflows?limit=50${after ? `&cursor=${after}` : ''}`,
        );
        setItems((prev) => (after && prev ? [...prev, ...page.items] : page.items));
        setCursor(page.nextCursor);
      } catch (e) {
        setError(problemMessage(e));
      }
    },
    [org.id],
  );

  useEffect(() => {
    void load(null);
  }, [load]);

  return (
    <>
      <PageHeader
        title="Workflows"
        description="Follow-up that runs by itself: when something happens to a lead, assign it, set a next step, send an email or notify someone"
        actions={
          <Link href={`${base}/new`} className={buttonClass('primary')}>
            <Plus aria-hidden className="size-4" strokeWidth={1.75} />
            New workflow
          </Link>
        }
      />
      <WorkflowsNav slug={org.slug} />
      <Card density="dense">
        {error ? <p role="alert">{error}</p> : null}
        {!items ? (
          <p aria-live="polite">Loading workflows</p>
        ) : items.length === 0 ? (
          <div className="flex flex-col items-start gap-4 p-2">
            <p>
              No workflows yet. Start with one that gives every new lead an owner and a first call
            </p>
            <Link href={`${base}/new`} className={buttonClass('secondary')}>
              Build your first workflow
            </Link>
          </div>
        ) : (
          <ul aria-label="Workflows" className="flex flex-col">
            {items.map((w) => (
              <li
                key={w.id}
                className="divider grid gap-2 py-4 first:border-t-0 sm:grid-cols-[1fr_auto] sm:items-center sm:gap-6"
              >
                <div className="min-w-0">
                  <p className="flex flex-wrap items-center gap-2">
                    <Link
                      href={`${base}/${w.id}`}
                      className="underline decoration-dotted underline-offset-4"
                    >
                      {w.name}
                    </Link>
                    <WorkflowStatus status={w.status} />
                    {w.isSample ? (
                      <Badge tone="limestone" className="bg-pumice">
                        Sample
                      </Badge>
                    ) : null}
                  </p>
                  <p className="mt-1 text-body-sm text-obsidian/80">
                    {TRIGGER_LABEL[w.trigger]} · version {w.latestVersion}
                    {w.activeVersion && w.activeVersion !== w.latestVersion
                      ? ` (version ${w.activeVersion} is running)`
                      : ''}
                  </p>
                </div>
                <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-body-sm tabular sm:justify-end">
                  <span>
                    <span className="sr-only">Last 30 days: </span>
                    {w.runs.succeeded} succeeded
                  </span>
                  <span>{w.runs.failed} failed</span>
                  <span className="text-obsidian/75">{w.runs.skipped} skipped</span>
                  <span className="caption text-obsidian/75">
                    {w.lastRunAt
                      ? `Last run ${formatInOrgTime(w.lastRunAt, org.timezone)}`
                      : 'No runs yet'}
                  </span>
                </div>
              </li>
            ))}
          </ul>
        )}
        {cursor ? (
          <div className="mt-4">
            <Button variant="secondary" onClick={() => load(cursor)}>
              Load more
            </Button>
          </div>
        ) : null}
      </Card>
      <p className="caption px-2 text-obsidian/75">Run counts cover the last 30 days</p>
    </>
  );
}
