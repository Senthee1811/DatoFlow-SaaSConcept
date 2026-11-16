'use client';

import type { LossReasonDto, PipelineDto, StageKindCode } from '@datoflow/shared';
import { Button, Card, Field, Input, Select } from '@datoflow/ui';
import { ArrowDown, ArrowUp, Plus, Trash2 } from 'lucide-react';
import { useEffect, useState, type FormEvent } from 'react';
import { toast } from 'sonner';
import { api, ApiProblem, problemMessage } from '@/lib/api';

interface StageRow {
  key: string;
  id?: string;
  name: string;
  slaHours: number;
  kind: StageKindCode;
  leadCount: number;
}

const KIND_LABEL: Record<StageKindCode, string> = { OPEN: 'Open', WON: 'Won', LOST: 'Lost' };

/** PIPE-01: add, rename, reorder, set SLA hours, mark as Won or Lost. */
export function PipelineEditor({ orgId }: { orgId: string }) {
  const [pipeline, setPipeline] = useState<PipelineDto | null>(null);
  const [rows, setRows] = useState<StageRow[]>([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reset = (p: PipelineDto) => {
    setPipeline(p);
    setRows(
      p.stages.map((s) => ({
        key: s.id,
        id: s.id,
        name: s.name,
        slaHours: s.slaHours,
        kind: s.kind,
        leadCount: s.leadCount,
      })),
    );
  };

  useEffect(() => {
    api<{ items: PipelineDto[] }>(`/v1/orgs/${orgId}/pipelines`)
      .then((r) => reset(r.items[0]!))
      .catch((e) => setError(problemMessage(e)));
  }, [orgId]);

  const update = (key: string, patch: Partial<StageRow>) =>
    setRows((r) => r.map((row) => (row.key === key ? { ...row, ...patch } : row)));
  const moveRow = (index: number, by: number) =>
    setRows((r) => {
      const next = [...r];
      const [row] = next.splice(index, 1);
      next.splice(index + by, 0, row!);
      return next;
    });

  async function save(event: FormEvent) {
    event.preventDefault();
    if (!pipeline) return;
    setSaving(true);
    setError(null);
    try {
      const saved = await api<PipelineDto>(`/v1/orgs/${orgId}/pipelines/${pipeline.id}/stages`, {
        method: 'PATCH',
        body: {
          stages: rows.map(({ id, name, slaHours, kind }) => ({
            ...(id ? { id } : {}),
            name,
            slaHours: Number(slaHours),
            kind,
          })),
        },
      });
      reset(saved);
      toast('Stages saved');
    } catch (e) {
      if (e instanceof ApiProblem && e.problem.code === 'STAGE_NOT_EMPTY') {
        const names = rows.filter((r) => r.id && e.problem.ids?.includes(r.id)).map((r) => r.name);
        const removed = pipeline.stages
          .filter((s) => e.problem.ids?.includes(s.id) && !rows.some((r) => r.id === s.id))
          .map((s) => s.name);
        setError(
          `Move the leads out of ${[...names, ...removed].join(', ')} first. A stage that holds leads cannot be removed or switch between open and closed`,
        );
      } else if (e instanceof ApiProblem && e.problem.errors?.length) {
        setError(e.problem.errors.map((x) => x.message).join('. '));
      } else setError(problemMessage(e));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card>
      <h2 className="display mb-2 text-heading">Stages</h2>
      <p className="mb-6 text-obsidian/80">
        The board shows stages in this order. A lead with no activity for longer than its stage SLA
        is stuck.
      </p>
      {!pipeline ? (
        <p aria-live="polite">{error ?? 'Loading stages'}</p>
      ) : (
        <form onSubmit={save} className="flex flex-col gap-4">
          <ol className="flex flex-col gap-3" aria-label="Stages">
            {rows.map((row, i) => (
              <li
                key={row.key}
                className="grid items-end gap-3 rounded-medium bg-pumice p-4 sm:grid-cols-[2fr_1fr_1fr_auto]"
              >
                <Field label={`Stage ${i + 1} name`}>
                  <Input
                    required
                    maxLength={40}
                    value={row.name}
                    onChange={(e) => update(row.key, { name: e.target.value })}
                  />
                </Field>
                <Field label="SLA hours">
                  <Input
                    type="number"
                    min={1}
                    max={8760}
                    required
                    value={row.slaHours}
                    disabled={row.kind !== 'OPEN'}
                    onChange={(e) => update(row.key, { slaHours: Number(e.target.value) })}
                  />
                </Field>
                <Field label="Kind">
                  <Select
                    value={row.kind}
                    onChange={(e) => update(row.key, { kind: e.target.value as StageKindCode })}
                  >
                    {(['OPEN', 'WON', 'LOST'] as const).map((k) => (
                      <option key={k} value={k}>
                        {KIND_LABEL[k]}
                      </option>
                    ))}
                  </Select>
                </Field>
                <div className="flex gap-1">
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    aria-label={`Move ${row.name} up`}
                    disabled={i === 0}
                    onClick={() => moveRow(i, -1)}
                  >
                    <ArrowUp aria-hidden className="size-4" strokeWidth={1.75} />
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    aria-label={`Move ${row.name} down`}
                    disabled={i === rows.length - 1}
                    onClick={() => moveRow(i, 1)}
                  >
                    <ArrowDown aria-hidden className="size-4" strokeWidth={1.75} />
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    aria-label={`Remove ${row.name}`}
                    title={row.leadCount ? `${row.leadCount} leads are in this stage` : undefined}
                    onClick={() => setRows((r) => r.filter((x) => x.key !== row.key))}
                  >
                    <Trash2 aria-hidden className="size-4" strokeWidth={1.75} />
                  </Button>
                </div>
                {row.leadCount ? (
                  <p className="caption sm:col-span-4">{row.leadCount} leads in this stage</p>
                ) : null}
              </li>
            ))}
          </ol>
          {error ? (
            <p role="alert" className="rounded-medium bg-sulfur px-5 py-3 text-body-sm">
              {error}
            </p>
          ) : null}
          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              variant="secondary"
              disabled={rows.length >= 12}
              onClick={() => {
                const firstClosed = rows.findIndex((r) => r.kind !== 'OPEN');
                const at = firstClosed === -1 ? rows.length : firstClosed;
                setRows((r) => [
                  ...r.slice(0, at),
                  {
                    key: crypto.randomUUID(),
                    name: 'New stage',
                    slaHours: 72,
                    kind: 'OPEN',
                    leadCount: 0,
                  },
                  ...r.slice(at),
                ]);
              }}
            >
              <Plus aria-hidden className="size-4" strokeWidth={1.75} />
              Add stage
            </Button>
            <Button type="submit" loading={saving}>
              Save stages
            </Button>
          </div>
        </form>
      )}
    </Card>
  );
}

export function LossReasonsEditor({ orgId }: { orgId: string }) {
  const [reasons, setReasons] = useState<(LossReasonDto & { key: string })[] | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    api<{ items: LossReasonDto[] }>(`/v1/orgs/${orgId}/loss-reasons`)
      .then((r) => setReasons(r.items.filter((x) => x.active).map((x) => ({ ...x, key: x.id }))))
      .catch((e) => toast(problemMessage(e)));
  }, [orgId]);

  async function save(event: FormEvent) {
    event.preventDefault();
    if (!reasons) return;
    setSaving(true);
    try {
      const saved = await api<{ items: LossReasonDto[] }>(`/v1/orgs/${orgId}/loss-reasons`, {
        method: 'PUT',
        body: {
          reasons: reasons.map(({ id, label }) => ({ ...(id ? { id } : {}), label, active: true })),
        },
      });
      setReasons(saved.items.filter((x) => x.active).map((x) => ({ ...x, key: x.id })));
      toast('Loss reasons saved');
    } catch (e) {
      toast(problemMessage(e));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card>
      <h2 className="display mb-2 text-heading">Loss reasons</h2>
      <p className="mb-6 text-obsidian/80">
        A lead moved to Lost needs one of these. Removed reasons stay on the leads that used them.
      </p>
      {!reasons ? (
        <p aria-live="polite">Loading</p>
      ) : (
        <form onSubmit={save} className="flex flex-col gap-3">
          <ul className="flex flex-col gap-2" aria-label="Loss reasons">
            {reasons.map((r, i) => (
              <li key={r.key} className="flex items-end gap-2">
                <Field label={`Reason ${i + 1}`} className="flex-1">
                  <Input
                    required
                    maxLength={60}
                    value={r.label}
                    onChange={(e) =>
                      setReasons((all) =>
                        all!.map((x) => (x.key === r.key ? { ...x, label: e.target.value } : x)),
                      )
                    }
                  />
                </Field>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  aria-label={`Remove ${r.label}`}
                  disabled={reasons.length === 1}
                  onClick={() => setReasons((all) => all!.filter((x) => x.key !== r.key))}
                >
                  <Trash2 aria-hidden className="size-4" strokeWidth={1.75} />
                </Button>
              </li>
            ))}
          </ul>
          <div className="flex flex-wrap gap-2 pt-2">
            <Button
              type="button"
              variant="secondary"
              onClick={() =>
                setReasons((all) => [
                  ...all!,
                  { key: crypto.randomUUID(), id: '', label: '', active: true },
                ])
              }
            >
              <Plus aria-hidden className="size-4" strokeWidth={1.75} />
              Add reason
            </Button>
            <Button type="submit" loading={saving}>
              Save reasons
            </Button>
          </div>
        </form>
      )}
    </Card>
  );
}
