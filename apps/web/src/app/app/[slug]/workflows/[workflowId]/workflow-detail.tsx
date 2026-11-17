'use client';

import type { ExecutionDto, Page, WorkflowDto } from '@datoflow/shared';
import { Badge, Button, buttonClass, Card } from '@datoflow/ui';
import { ArrowLeft, Pause, Play } from 'lucide-react';
import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { api, ApiProblem, problemMessage } from '@/lib/api';
import { useLookups } from '@/lib/lookups';
import { formatInOrgTime, useOrg } from '@/lib/org-context';
import { Builder, type FieldErrors } from '../builder';
import {
  describeAction,
  describeCondition,
  RunStatus,
  TRIGGER_LABEL,
  WorkflowStatus,
} from '../labels';

export function WorkflowDetail({ workflowId }: { workflowId: string }) {
  const { org } = useOrg();
  const { lookups, error: lookupError } = useLookups(org.id);
  const [workflow, setWorkflow] = useState<WorkflowDto | null>(null);
  const [runs, setRuns] = useState<ExecutionDto[] | null>(null);
  const [missing, setMissing] = useState(false);
  const [errors, setErrors] = useState<FieldErrors>([]);
  const [busy, setBusy] = useState<'save' | 'status' | null>(null);
  // Remounts the builder after a save, so it starts from the version just saved.
  const [formKey, setFormKey] = useState(0);
  const path = `/v1/orgs/${org.id}/workflows/${workflowId}`;
  const base = `/app/${org.slug}/workflows`;

  const load = useCallback(async () => {
    try {
      const [w, r] = await Promise.all([
        api<WorkflowDto>(path),
        api<Page<ExecutionDto>>(`/v1/orgs/${org.id}/executions?workflowId=${workflowId}&limit=10`),
      ]);
      setWorkflow(w);
      setRuns(r.items);
    } catch (e) {
      if (e instanceof ApiProblem && e.status === 404) setMissing(true);
      else toast(problemMessage(e));
    }
  }, [path, org.id, workflowId]);

  useEffect(() => {
    void load();
  }, [load]);

  async function setStatus(action: 'activate' | 'pause') {
    setBusy('status');
    try {
      const w = await api<WorkflowDto>(`${path}/${action}`, { method: 'POST', body: {} });
      setWorkflow(w);
      toast(
        action === 'pause'
          ? 'Workflow paused. Runs waiting in the queue were cancelled'
          : `Workflow active with version ${w.activeVersion}`,
      );
      void load();
    } catch (e) {
      toast(problemMessage(e));
    } finally {
      setBusy(null);
    }
  }

  if (missing) {
    return (
      <Card className="flex flex-col items-start gap-4">
        <h1 className="display text-heading-lg">Workflow not found</h1>
        <Link href={base} className={buttonClass('secondary')}>
          Back to workflows
        </Link>
      </Card>
    );
  }
  if (!workflow || !lookups) {
    return <p aria-live="polite">{lookupError ?? 'Loading the workflow'}</p>;
  }

  const statusAction =
    workflow.status === 'ACTIVE' ? (
      <Button variant="secondary" loading={busy === 'status'} onClick={() => setStatus('pause')}>
        <Pause aria-hidden className="size-4" strokeWidth={1.75} />
        Pause
      </Button>
    ) : (
      <Button loading={busy === 'status'} onClick={() => setStatus('activate')}>
        <Play aria-hidden className="size-4" strokeWidth={1.75} />
        {workflow.status === 'PAUSED' ? 'Resume' : 'Activate'}
      </Button>
    );

  return (
    <>
      <div className="flex flex-wrap items-end justify-between gap-4 px-2 pt-4">
        <div className="min-w-0">
          <Link href={base} className={buttonClass('ghost', 'sm', '-ml-3 mb-2')}>
            <ArrowLeft aria-hidden className="size-4" strokeWidth={1.75} />
            Workflows
          </Link>
          <h1 className="display text-heading-lg break-words">{workflow.name}</h1>
          <p className="mt-2 flex flex-wrap items-center gap-2 text-obsidian/80">
            <WorkflowStatus status={workflow.status} />
            {workflow.isSample ? (
              <Badge tone="limestone" className="bg-pumice">
                Sample: runs on sample leads only
              </Badge>
            ) : null}
            <span className="text-body-sm">
              {workflow.status === 'ACTIVE'
                ? `Version ${workflow.activeVersion} is running`
                : `Version ${workflow.latestVersion} saved`}
            </span>
          </p>
        </div>
        {statusAction}
      </div>

      <div className="grid items-start gap-6 lg:grid-cols-[3fr_2fr]">
        <Builder
          key={formKey}
          lookups={lookups}
          errors={errors}
          saving={busy === 'save'}
          submitLabel={`Save as version ${workflow.latestVersion + 1}`}
          initial={{ name: workflow.name, definition: workflow.definition }}
          onSubmit={async (value) => {
            setBusy('save');
            setErrors([]);
            try {
              const w = await api<WorkflowDto>(`${path}/versions`, {
                method: 'POST',
                body: { name: value.name, definition: value.definition },
              });
              setWorkflow(w);
              setFormKey((k) => k + 1);
              toast(
                w.status === 'ACTIVE'
                  ? `Version ${w.latestVersion} saved and running`
                  : `Version ${w.latestVersion} saved`,
              );
            } catch (e) {
              if (e instanceof ApiProblem && e.problem.errors) setErrors(e.problem.errors);
              else toast(problemMessage(e));
            } finally {
              setBusy(null);
            }
          }}
        />

        <div className="flex flex-col gap-6">
          <Card density="dense" aria-labelledby="runs-title" className="flex flex-col gap-4">
            <div className="flex items-baseline justify-between gap-4">
              <h2 id="runs-title" className="display text-heading">
                Recent runs
              </h2>
              <Link
                href={`${base}/runs?workflowId=${workflow.id}`}
                className="text-body-sm underline decoration-dotted underline-offset-4"
              >
                All runs
              </Link>
            </div>
            {!runs?.length ? (
              <p className="text-obsidian/80">No runs yet</p>
            ) : (
              <ul aria-label="Recent runs" className="flex flex-col">
                {runs.map((r) => (
                  <li
                    key={r.id}
                    className="divider flex flex-wrap items-center gap-2 py-3 first:border-t-0"
                  >
                    <RunStatus status={r.status} />
                    <Link
                      href={`${base}/runs/${r.id}`}
                      className="min-w-0 flex-1 truncate underline decoration-dotted underline-offset-4"
                    >
                      {r.leadName ?? 'Lead removed'}
                    </Link>
                    <time dateTime={r.createdAt} className="caption tabular text-obsidian/75">
                      {formatInOrgTime(r.createdAt, org.timezone)}
                    </time>
                  </li>
                ))}
              </ul>
            )}
          </Card>

          <Card density="dense" aria-labelledby="versions-title" className="flex flex-col gap-4">
            <h2 id="versions-title" className="display text-heading">
              Versions
            </h2>
            <p className="text-body-sm text-obsidian/80">
              Saved versions never change. Runs already queued finish on the version they started
            </p>
            <ol aria-label="Versions" className="flex flex-col">
              {workflow.versions.map((v) => (
                <li key={v.id} className="divider flex flex-col gap-1 py-3 first:border-t-0">
                  <p className="flex flex-wrap items-center gap-2">
                    <span>Version {v.version}</span>
                    {workflow.status === 'ACTIVE' && v.version === workflow.activeVersion ? (
                      <Badge tone="sulfur">Running</Badge>
                    ) : null}
                  </p>
                  <p className="caption text-obsidian/75">
                    {formatInOrgTime(v.createdAt, org.timezone)}
                    {v.createdByName ? `, ${v.createdByName}` : ''}
                  </p>
                  <details className="text-body-sm">
                    <summary className="cursor-pointer underline decoration-dotted underline-offset-4">
                      What it does
                    </summary>
                    <ul className="mt-2 flex list-disc flex-col gap-1 pl-5">
                      <li>When: {TRIGGER_LABEL[v.definition.trigger].toLowerCase()}</li>
                      {v.definition.conditions.map((c, i) => (
                        <li key={`c${i}`}>Only if {describeCondition(c, lookups).toLowerCase()}</li>
                      ))}
                      {v.definition.actions.map((a, i) => (
                        <li key={`a${i}`}>
                          {i + 1}. {describeAction(a, lookups)}
                        </li>
                      ))}
                    </ul>
                  </details>
                </li>
              ))}
            </ol>
          </Card>
        </div>
      </div>
    </>
  );
}
