'use client';

import type { ExecutionDto, Page, WorkflowSummaryDto } from '@datoflow/shared';
import { Button, Card, Field, Select } from '@datoflow/ui';
import { EXECUTION_STATUSES, type ExecutionStatus } from '@datoflow/workflow';
import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useCallback, useEffect, useState } from 'react';
import { api, problemMessage } from '@/lib/api';
import { formatInOrgTime, useOrg } from '@/lib/org-context';
import { PageHeader } from '../../page-header';
import { EVENT_LABEL, RunStatus, runNote } from '../labels';
import { WorkflowsNav } from '../workflows-nav';

const STATUS_LABEL: Record<ExecutionStatus, string> = {
  QUEUED: 'Queued',
  RUNNING: 'Running',
  SUCCEEDED: 'Succeeded',
  SKIPPED: 'Skipped',
  CANCELLED: 'Cancelled',
  FAILED: 'Failed, retrying',
  DEAD: 'Dead',
};

/** The execution log (WF-06): every run, newest first, with filters. */
export default function RunsPage() {
  return (
    <Suspense fallback={<p aria-live="polite">Loading runs</p>}>
      <Runs />
    </Suspense>
  );
}

function Runs() {
  const { org } = useOrg();
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const workflowId = params.get('workflowId') ?? '';
  const status = params.get('status') ?? '';
  const [items, setItems] = useState<ExecutionDto[] | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [workflows, setWorkflows] = useState<WorkflowSummaryDto[]>([]);
  const [error, setError] = useState<string | null>(null);
  const base = `/app/${org.slug}/workflows`;

  const load = useCallback(
    async (after: string | null) => {
      const q = new URLSearchParams({ limit: '50' });
      if (workflowId) q.set('workflowId', workflowId);
      if (status) q.set('status', status);
      if (after) q.set('cursor', after);
      try {
        const page = await api<Page<ExecutionDto>>(`/v1/orgs/${org.id}/executions?${q}`);
        setItems((prev) => (after && prev ? [...prev, ...page.items] : page.items));
        setCursor(page.nextCursor);
        setError(null);
      } catch (e) {
        setError(problemMessage(e));
      }
    },
    [org.id, workflowId, status],
  );

  useEffect(() => {
    setItems(null);
    void load(null);
  }, [load]);

  useEffect(() => {
    api<Page<WorkflowSummaryDto>>(`/v1/orgs/${org.id}/workflows?limit=100`)
      .then((p) => setWorkflows(p.items))
      .catch(() => undefined);
  }, [org.id]);

  function setFilter(key: string, value: string) {
    const next = new URLSearchParams(params);
    if (value) next.set(key, value);
    else next.delete(key);
    router.replace(`${pathname}${next.size ? `?${next}` : ''}`);
  }

  return (
    <>
      <PageHeader
        title="Run log"
        description={`Each run of a workflow for one event: what it did, how many attempts it took and what went wrong. Times in ${org.timezone.replaceAll('_', ' ')}`}
      />
      <WorkflowsNav slug={org.slug} />
      <Card density="dense" className="flex flex-col gap-4">
        <div className="grid gap-4 sm:grid-cols-2 lg:max-w-2xl">
          <Field label="Workflow">
            <Select value={workflowId} onChange={(e) => setFilter('workflowId', e.target.value)}>
              <option value="">All workflows</option>
              {workflows.map((w) => (
                <option key={w.id} value={w.id}>
                  {w.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Status">
            <Select value={status} onChange={(e) => setFilter('status', e.target.value)}>
              <option value="">Any status</option>
              {EXECUTION_STATUSES.map((s) => (
                <option key={s} value={s}>
                  {STATUS_LABEL[s]}
                </option>
              ))}
            </Select>
          </Field>
        </div>
        {error ? <p role="alert">{error}</p> : null}
        {!items ? (
          <p aria-live="polite">Loading runs</p>
        ) : items.length === 0 ? (
          <p>No runs match. Runs appear here as soon as an event starts an active workflow</p>
        ) : (
          <ul aria-label="Runs" className="flex flex-col">
            {items.map((r) => {
              const note = runNote(r);
              return (
                <li
                  key={r.id}
                  className="divider grid gap-2 py-4 first:border-t-0 sm:grid-cols-[10rem_1fr_auto] sm:items-start sm:gap-4"
                >
                  <div>
                    <RunStatus status={r.status} />
                  </div>
                  <div className="min-w-0">
                    <p>
                      <Link
                        href={`${base}/runs/${r.id}`}
                        className="underline decoration-dotted underline-offset-4"
                      >
                        {r.workflowName}
                      </Link>{' '}
                      <span className="text-obsidian/80">
                        on {r.leadName ?? 'a removed lead'} ·{' '}
                        {EVENT_LABEL[r.eventType] ?? r.eventType}
                      </span>
                    </p>
                    {note ? <p className="mt-1 text-body-sm text-obsidian/80">{note}</p> : null}
                  </div>
                  <div className="flex flex-col gap-1 sm:items-end">
                    <time dateTime={r.createdAt} className="caption tabular text-obsidian/75">
                      {formatInOrgTime(r.createdAt, org.timezone)}
                    </time>
                    {r.attempt > 0 ? (
                      <span className="caption tabular text-obsidian/75">
                        {r.attempt} {r.attempt === 1 ? 'attempt' : 'attempts'}
                      </span>
                    ) : null}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
        {cursor ? (
          <div>
            <Button variant="secondary" onClick={() => load(cursor)}>
              Load older runs
            </Button>
          </div>
        ) : null}
      </Card>
    </>
  );
}
