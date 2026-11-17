'use client';

import type { ExecutionDetailDto } from '@datoflow/shared';
import { Badge, Button, buttonClass, Card, StatusBadge } from '@datoflow/ui';
import { ArrowLeft, RotateCw } from 'lucide-react';
import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { api, ApiProblem, problemMessage } from '@/lib/api';
import { useLookups } from '@/lib/lookups';
import { formatInOrgTime, useOrg } from '@/lib/org-context';
import { describeAction, EVENT_LABEL, RunStatus, runNote } from '../../labels';

/** One run (WF-06): its steps, attempts and errors, and a retry for FAILED or DEAD runs. */
export function RunDetail({ executionId }: { executionId: string }) {
  const { org } = useOrg();
  const { lookups } = useLookups(org.id);
  const [run, setRun] = useState<ExecutionDetailDto | null>(null);
  const [missing, setMissing] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const path = `/v1/orgs/${org.id}/executions/${executionId}`;
  const base = `/app/${org.slug}/workflows`;

  const load = useCallback(async () => {
    try {
      setRun(await api<ExecutionDetailDto>(path));
    } catch (e) {
      if (e instanceof ApiProblem && e.status === 404) setMissing(true);
      else toast(problemMessage(e));
    }
  }, [path]);

  useEffect(() => {
    void load();
  }, [load]);

  // While a run is waiting or going, check on it every few seconds.
  const live = run && ['QUEUED', 'RUNNING', 'FAILED'].includes(run.status);
  useEffect(() => {
    if (!live) return;
    const t = setInterval(() => void load(), 3000);
    return () => clearInterval(t);
  }, [live, load]);

  if (missing) {
    return (
      <Card className="flex flex-col items-start gap-4">
        <h1 className="display text-heading-lg">Run not found</h1>
        <Link href={`${base}/runs`} className={buttonClass('secondary')}>
          Back to the run log
        </Link>
      </Card>
    );
  }
  if (!run || !lookups) return <p aria-live="polite">Loading the run</p>;

  const note = runNote(run);
  const steps = new Map(run.steps.map((s) => [s.stepIndex, s]));

  return (
    <>
      <div className="flex flex-wrap items-end justify-between gap-4 px-2 pt-4">
        <div className="min-w-0">
          <Link href={`${base}/runs`} className={buttonClass('ghost', 'sm', '-ml-3 mb-2')}>
            <ArrowLeft aria-hidden className="size-4" strokeWidth={1.75} />
            Run log
          </Link>
          <h1 className="display text-heading-lg break-words">{run.workflowName}</h1>
          <p className="mt-2 flex flex-wrap items-center gap-2 text-obsidian/80">
            <RunStatus status={run.status} />
            <span className="text-body-sm">
              Version {run.version} · {EVENT_LABEL[run.eventType] ?? run.eventType}
              {run.depth > 0 ? ` · raised by another workflow, depth ${run.depth}` : ''}
            </span>
          </p>
        </div>
        {run.canRetry ? (
          <Button
            loading={retrying}
            onClick={async () => {
              setRetrying(true);
              try {
                setRun(
                  await api<ExecutionDetailDto>(`${path}/retry`, { method: 'POST', body: {} }),
                );
                toast('Run queued again. Steps that already succeeded will not repeat');
              } catch (e) {
                toast(problemMessage(e));
              } finally {
                setRetrying(false);
              }
            }}
          >
            <RotateCw aria-hidden className="size-4" strokeWidth={1.75} />
            Retry
          </Button>
        ) : null}
      </div>

      <div className="grid items-start gap-6 lg:grid-cols-[3fr_2fr]">
        <Card aria-labelledby="steps-title" className="flex flex-col gap-4">
          <h2 id="steps-title" className="display text-heading">
            Steps
          </h2>
          {note ? (
            <p
              role={run.status === 'DEAD' ? 'alert' : undefined}
              className="rounded-medium bg-pumice p-4"
            >
              {note}
            </p>
          ) : null}
          <ol aria-label="Steps" className="flex flex-col">
            {run.actions.map((a, i) => {
              const s = steps.get(i);
              return (
                <li
                  key={i}
                  className="divider grid gap-2 py-4 first:border-t-0 sm:grid-cols-[2rem_1fr_auto] sm:gap-4"
                >
                  <span className="tabular text-obsidian/75">{i + 1}</span>
                  <div className="min-w-0">
                    <p>{describeAction(a, lookups)}</p>
                    {s?.error ? (
                      <p className="mt-1 text-body-sm text-obsidian/80">
                        Attempt {s.attempt}: {s.error}
                      </p>
                    ) : null}
                  </div>
                  <div>
                    {s?.status === 'SUCCEEDED' ? (
                      <StatusBadge status="done">Done</StatusBadge>
                    ) : s?.status === 'FAILED' ? (
                      <StatusBadge status="attention">Failed</StatusBadge>
                    ) : (
                      <Badge tone="limestone" className="bg-pumice">
                        Not run
                      </Badge>
                    )}
                  </div>
                </li>
              );
            })}
          </ol>
        </Card>

        <Card density="dense" aria-labelledby="facts-title" className="flex flex-col gap-4">
          <h2 id="facts-title" className="display text-heading">
            Details
          </h2>
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-body-sm">
            <dt className="text-obsidian/75">Lead</dt>
            <dd>
              {run.leadId && run.leadName ? (
                <Link
                  href={`/app/${org.slug}/leads/${run.leadId}`}
                  className="underline decoration-dotted underline-offset-4"
                >
                  {run.leadName}
                </Link>
              ) : (
                'Removed'
              )}
            </dd>
            <dt className="text-obsidian/75">Workflow</dt>
            <dd>
              <Link
                href={`${base}/${run.workflowId}`}
                className="underline decoration-dotted underline-offset-4"
              >
                {run.workflowName}
              </Link>
            </dd>
            <dt className="text-obsidian/75">Attempts</dt>
            <dd className="tabular">
              {run.attempt} of 5
              {run.manualRetries
                ? `, retried by hand ${run.manualRetries} ${run.manualRetries === 1 ? 'time' : 'times'}`
                : ''}
            </dd>
            {run.nextAttemptAt ? (
              <>
                <dt className="text-obsidian/75">Next attempt</dt>
                <dd className="tabular">{formatInOrgTime(run.nextAttemptAt, org.timezone)}</dd>
              </>
            ) : null}
            <dt className="text-obsidian/75">Queued</dt>
            <dd className="tabular">{formatInOrgTime(run.createdAt, org.timezone)}</dd>
            {run.startedAt ? (
              <>
                <dt className="text-obsidian/75">Started</dt>
                <dd className="tabular">{formatInOrgTime(run.startedAt, org.timezone)}</dd>
              </>
            ) : null}
            {run.finishedAt ? (
              <>
                <dt className="text-obsidian/75">Finished</dt>
                <dd className="tabular">{formatInOrgTime(run.finishedAt, org.timezone)}</dd>
              </>
            ) : null}
            {run.errorKind ? (
              <>
                <dt className="text-obsidian/75">Error kind</dt>
                <dd>
                  {run.errorKind === 'TRANSIENT'
                    ? 'Temporary: retried automatically'
                    : 'Needs a change: not retried automatically'}
                </dd>
              </>
            ) : null}
          </dl>
        </Card>
      </div>
    </>
  );
}
