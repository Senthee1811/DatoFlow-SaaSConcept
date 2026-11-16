'use client';

import { can, PRIORITY_LABEL, SOURCE_LABEL } from '@datoflow/domain';
import type { ActivityDto, LeadDto, Page } from '@datoflow/shared';
import {
  Badge,
  Button,
  buttonClass,
  Card,
  Field,
  Select,
  StatusBadge,
  Textarea,
} from '@datoflow/ui';
import { ArrowLeft, Copy } from 'lucide-react';
import Link from 'next/link';
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { toast } from 'sonner';
import { api, ApiProblem, problemMessage } from '@/lib/api';
import { formatMoney, useLookups, type Lookups } from '@/lib/lookups';
import { formatInOrgTime, useOrg } from '@/lib/org-context';
import { CloseDialog, needsCloseDialog, type CloseRequest } from '../close-dialog';
import { LeadBadges } from '../lead-badges';
import { initialValues, LeadForm, toBody } from '../lead-form';

const REASON_TEXT = {
  EMAIL: 'same email',
  PHONE: 'same phone',
  NAME_COMPANY: 'same name and company',
} as const;

export function LeadDetail({ leadId }: { leadId: string }) {
  const { org } = useOrg();
  const { lookups, error: lookupError } = useLookups(org.id);
  const [lead, setLead] = useState<LeadDto | null>(null);
  const [missing, setMissing] = useState(false);
  const [timelineKey, setTimelineKey] = useState(0);
  const [closing, setClosing] = useState<(CloseRequest & { stageId: string }) | null>(null);
  const base = `/v1/orgs/${org.id}/leads/${leadId}`;

  const load = useCallback(async () => {
    try {
      setLead(await api<LeadDto>(base));
    } catch (e) {
      if (e instanceof ApiProblem && e.status === 404) setMissing(true);
      else toast(problemMessage(e));
    }
  }, [base]);

  useEffect(() => {
    void load();
  }, [load]);

  async function patch(body: Record<string, unknown>, success: string) {
    try {
      setLead(await api<LeadDto>(base, { method: 'PATCH', body }));
      setTimelineKey((k) => k + 1);
      toast(success);
    } catch (e) {
      toast(problemMessage(e));
      await load();
    }
  }

  if (missing) {
    return (
      <Card>
        <h1 className="display mb-4 text-heading-lg">Lead not found</h1>
        <p className="mb-6">
          It may belong to another workspace, or to a teammate whose leads you cannot see.
        </p>
        <Link href={`/app/${org.slug}/leads`} className={buttonClass('secondary')}>
          Back to leads
        </Link>
      </Card>
    );
  }
  if (!lead || !lookups) return <p aria-live="polite">{lookupError ?? 'Loading the lead'}</p>;

  const stage = lookups.stageById.get(lead.stageId);
  const canAssign = can(org.role, 'leads.reassign');
  const canArchive = can(org.role, 'leads.archive');
  const editable = lead.canEdit && !lead.archivedAt;

  function changeStage(stageId: string) {
    const target = lookups!.stageById.get(stageId);
    if (!target || !lead) return;
    if (needsCloseDialog(target, lead.dealValue, org.settings.wonRequiresDealValue ?? true)) {
      setClosing({ stageId, leadName: lead.name, stage: target, dealValue: lead.dealValue });
      return;
    }
    void patch({ stageId }, `Moved to ${target.name}`);
  }

  return (
    <>
      <div className="flex flex-wrap items-end justify-between gap-4 px-2 pt-4">
        <div className="min-w-0">
          <Link
            href={`/app/${org.slug}/leads`}
            className={buttonClass('ghost', 'sm', '-ml-3 mb-2')}
          >
            <ArrowLeft aria-hidden className="size-4" strokeWidth={1.75} />
            Leads
          </Link>
          <h1 className="display text-heading-lg break-words">{lead.name}</h1>
          <p className="mt-2 flex flex-wrap items-center gap-2 text-obsidian/80">
            {lead.company ? <span>{lead.company}</span> : null}
            <LeadBadges lead={lead} />
          </p>
        </div>
        {canArchive ? (
          <Button
            variant="secondary"
            onClick={async () => {
              try {
                setLead(
                  await api<LeadDto>(`${base}/${lead.archivedAt ? 'restore' : 'archive'}`, {
                    method: 'POST',
                    body: {},
                  }),
                );
                setTimelineKey((k) => k + 1);
                toast(lead.archivedAt ? 'Lead restored' : 'Lead archived');
              } catch (e) {
                toast(problemMessage(e));
              }
            }}
          >
            {lead.archivedAt ? 'Restore' : 'Archive'}
          </Button>
        ) : null}
      </div>

      {lead.duplicates.length > 0 ? (
        <section
          aria-labelledby="dup-title"
          className="flex flex-col gap-2 rounded-cards bg-sulfur p-6"
        >
          <h2 id="dup-title" className="flex items-center gap-2 text-body">
            <Copy aria-hidden className="size-4" strokeWidth={1.75} />
            Possible duplicate
          </h2>
          <ul className="flex flex-col gap-1">
            {lead.duplicates.map((d) => (
              <li key={d.leadId} className="text-body-sm">
                <Link
                  href={`/app/${org.slug}/leads/${d.leadId}`}
                  className="underline decoration-dotted underline-offset-4"
                >
                  {d.name}
                  {d.company ? `, ${d.company}` : ''}
                </Link>{' '}
                ({REASON_TEXT[d.reason]})
              </li>
            ))}
          </ul>
          <p className="caption">DatoFlow never merges leads by itself.</p>
        </section>
      ) : null}

      <div className="grid items-start gap-6 lg:grid-cols-[3fr_2fr]">
        <Card>
          <h2 className="display mb-6 text-heading">Details</h2>
          <LeadForm
            key={lead.updatedAt}
            initial={initialValues(lead)}
            lookups={lookups}
            currency={lead.currency}
            disabled={!editable}
            submitLabel="Save changes"
            onSubmit={async (values) => {
              setLead(await api<LeadDto>(base, { method: 'PATCH', body: toBody(values) }));
              setTimelineKey((k) => k + 1);
              toast('Lead saved');
            }}
          />
          {!lead.canEdit ? (
            <p className="mt-4 text-body-sm text-obsidian/80">
              Only the lead&apos;s owner or a manager can change it.
            </p>
          ) : null}
        </Card>

        <div className="flex flex-col gap-6">
          <Card density="dense" className="flex flex-col gap-4">
            <h2 className="display text-heading">Pipeline</h2>
            <Field label="Stage">
              <Select
                value={lead.stageId}
                disabled={!editable}
                onChange={(e) => changeStage(e.target.value)}
              >
                {lookups.stages.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Owner" hint={canAssign ? undefined : 'Only managers reassign leads'}>
              <Select
                value={lead.ownerId ?? ''}
                disabled={!editable || !canAssign}
                onChange={(e) => {
                  const ownerId = e.target.value || null;
                  const name = ownerId ? lookups.assigneeById.get(ownerId)?.name : null;
                  void patch(
                    { ownerId },
                    name ? `Assigned to ${name}` : 'Moved to the unassigned pool',
                  );
                }}
              >
                <option value="">Unassigned</option>
                {lookups.assignees.map((a) => (
                  <option key={a.userId} value={a.userId}>
                    {a.name}
                  </option>
                ))}
              </Select>
            </Field>
            <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-body-sm">
              <dt className="text-obsidian/75">In stage since</dt>
              <dd>{formatInOrgTime(lead.stageEnteredAt, org.timezone)}</dd>
              <dt className="text-obsidian/75">Last activity</dt>
              <dd>{formatInOrgTime(lead.lastActivityAt, org.timezone)}</dd>
              {lead.slaDueAt ? (
                <>
                  <dt className="text-obsidian/75">{lead.stuck ? 'Stuck since' : 'Stuck after'}</dt>
                  <dd>{formatInOrgTime(lead.slaDueAt, org.timezone)}</dd>
                </>
              ) : null}
              <dt className="text-obsidian/75">Source</dt>
              <dd>{SOURCE_LABEL[lead.source]}</dd>
              <dt className="text-obsidian/75">Priority</dt>
              <dd>{PRIORITY_LABEL[lead.priority]}</dd>
              {lead.dealValue !== null ? (
                <>
                  <dt className="text-obsidian/75">Value</dt>
                  <dd className="tabular">{formatMoney(lead.dealValue, lead.currency)}</dd>
                </>
              ) : null}
              {lead.lossReasonId ? (
                <>
                  <dt className="text-obsidian/75">Lost because</dt>
                  <dd>
                    {lookups.lossReasons.find((r) => r.id === lead.lossReasonId)?.label ??
                      'Retired reason'}
                  </dd>
                </>
              ) : null}
              {lead.utm?.campaign ? (
                <>
                  <dt className="text-obsidian/75">Campaign</dt>
                  <dd className="break-words">{lead.utm.campaign}</dd>
                </>
              ) : null}
            </dl>
            {stage?.kind !== 'OPEN' ? (
              <StatusBadge status="done">{stage?.kind === 'WON' ? 'Won' : 'Lost'}</StatusBadge>
            ) : null}
          </Card>
          <Timeline
            key={timelineKey}
            base={base}
            lookups={lookups}
            canNote={editable}
            timezone={org.timezone}
          />
        </div>
      </div>

      <CloseDialog
        request={closing}
        lossReasons={lookups.lossReasons}
        currency={lead.currency}
        onDone={(extra) => {
          const request = closing;
          setClosing(null);
          if (request && extra)
            void patch({ stageId: request.stageId, ...extra }, `Moved to ${request.stage.name}`);
        }}
      />
    </>
  );
}

const FIELD_LABEL: Record<string, string> = {
  name: 'name',
  company: 'company',
  email: 'email',
  phone: 'phone',
  source: 'source',
  priority: 'priority',
  dealValue: 'deal value',
  notes: 'notes',
  utm: 'campaign details',
};

function describe(a: ActivityDto, lookups: Lookups): string {
  const stage = (id: unknown) => lookups.stageById.get(String(id))?.name ?? 'a removed stage';
  const person = (id: unknown) =>
    id ? (lookups.assigneeById.get(String(id))?.name ?? 'a former member') : 'the unassigned pool';
  switch (a.type) {
    case 'CREATED':
      return 'added the lead';
    case 'UPDATED': {
      const fields = ((a.payload.changes as { field: string }[] | undefined) ?? []).map(
        (c) => FIELD_LABEL[c.field] ?? c.field,
      );
      return `changed ${fields.join(', ')}`;
    }
    case 'STAGE_CHANGED':
      return `moved it from ${stage(a.payload.fromStageId)} to ${stage(a.payload.toStageId)}`;
    case 'ASSIGNED':
      return a.payload.toOwnerId
        ? `assigned it to ${person(a.payload.toOwnerId)}`
        : 'moved it to the unassigned pool';
    case 'NOTE':
      return 'added a note';
    case 'ARCHIVED':
      return 'archived the lead';
    case 'RESTORED':
      return 'restored the lead';
    case 'DUPLICATE_FOUND':
      return `flagged a possible duplicate: ${String(a.payload.candidateName ?? '')}`;
    default:
      return a.type.toLowerCase().replaceAll('_', ' ');
  }
}

function Timeline({
  base,
  lookups,
  canNote,
  timezone,
}: {
  base: string;
  lookups: Lookups;
  canNote: boolean;
  timezone: string;
}) {
  const [items, setItems] = useState<ActivityDto[] | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [note, setNote] = useState('');
  const [saving, setSaving] = useState(false);

  const load = useCallback(
    async (after: string | null) => {
      const page = await api<Page<ActivityDto>>(
        `${base}/activities?limit=30${after ? `&cursor=${after}` : ''}`,
      );
      setItems((prev) => (after && prev ? [...prev, ...page.items] : page.items));
      setCursor(page.nextCursor);
    },
    [base],
  );

  useEffect(() => {
    void load(null).catch((e) => toast(problemMessage(e)));
  }, [load]);

  async function addNote(event: FormEvent) {
    event.preventDefault();
    if (!note.trim()) return;
    setSaving(true);
    try {
      await api(`${base}/activities`, { method: 'POST', body: { type: 'NOTE', text: note } });
      setNote('');
      await load(null);
    } catch (e) {
      toast(problemMessage(e));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card density="dense">
      <h2 className="display mb-4 text-heading">Timeline</h2>
      {canNote ? (
        <form onSubmit={addNote} className="mb-6 flex flex-col gap-3">
          <Field label="Note">
            <Textarea
              rows={3}
              maxLength={5000}
              value={note}
              onChange={(e) => setNote(e.target.value)}
            />
          </Field>
          <div>
            <Button
              type="submit"
              variant="secondary"
              size="sm"
              loading={saving}
              disabled={!note.trim()}
            >
              Add note
            </Button>
          </div>
        </form>
      ) : null}
      {!items ? (
        <p aria-live="polite">Loading the timeline</p>
      ) : (
        <ol aria-label="Timeline" className="flex flex-col">
          {items.map((a) => (
            <li key={a.id} className="divider flex flex-col gap-1 py-3 first:border-t-0">
              <p className="text-body-sm">
                <span>{a.actor.name}</span>{' '}
                <span className="text-obsidian/80">{describe(a, lookups)}</span>
                {a.actor.type === 'WORKFLOW' ? (
                  <Badge tone="limestone" className="ml-2">
                    Automated
                  </Badge>
                ) : null}
              </p>
              {a.type === 'NOTE' ? (
                <p className="whitespace-pre-wrap">{String(a.payload.text ?? '')}</p>
              ) : null}
              <time dateTime={a.occurredAt} className="caption tabular text-obsidian/75">
                {formatInOrgTime(a.occurredAt, timezone)}
              </time>
            </li>
          ))}
        </ol>
      )}
      {cursor ? (
        <Button variant="ghost" size="sm" onClick={() => load(cursor)}>
          Show older
        </Button>
      ) : null}
    </Card>
  );
}
