'use client';

import {
  DndContext,
  PointerSensor,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core';
import type { LeadFilters, LeadSummaryDto, Page, StageDto } from '@datoflow/shared';
import { Button, cn } from '@datoflow/ui';
import { GripVertical } from 'lucide-react';
import Link from 'next/link';
import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { toast } from 'sonner';
import { api, problemMessage } from '@/lib/api';
import { formatMoney, type Lookups } from '@/lib/lookups';
import { CloseDialog, needsCloseDialog, type CloseRequest } from './close-dialog';
import { filtersToQuery } from './filters';
import { LeadBadges } from './lead-badges';

interface Column {
  leads: LeadSummaryDto[];
  cursor: string | null;
  loading: boolean;
}

interface Picked {
  leadId: string;
  from: string;
  target: string;
}

const PER_COLUMN = 50;

export function LeadBoard({
  orgId,
  slug,
  filters,
  lookups,
  currency,
  wonRequiresDealValue,
}: {
  orgId: string;
  slug: string;
  filters: LeadFilters;
  lookups: Lookups;
  currency: string;
  wonRequiresDealValue: boolean;
}) {
  const stages = lookups.stages;
  const [columns, setColumns] = useState<Record<string, Column>>({});
  const [picked, setPicked] = useState<Picked | null>(null);
  const [announcement, setAnnouncement] = useState('');
  const [closing, setClosing] = useState<(CloseRequest & { leadId: string; from: string }) | null>(
    null,
  );
  const focusAfterMove = useRef<string | null>(null);
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }));
  // The board shows every stage, so a stage filter does not apply here.
  const query = filtersToQuery(
    { ...filters, stage: undefined, status: undefined },
    { limit: String(PER_COLUMN) },
  );

  const loadColumn = useCallback(
    async (stageId: string, after: string | null) => {
      setColumns((c) => ({
        ...c,
        [stageId]: { ...(c[stageId] ?? { leads: [], cursor: null }), loading: true },
      }));
      try {
        const page = await api<Page<LeadSummaryDto>>(
          `/v1/orgs/${orgId}/leads?${query}&stage=${stageId}${after ? `&cursor=${after}` : ''}`,
        );
        setColumns((c) => ({
          ...c,
          [stageId]: {
            leads: after ? [...(c[stageId]?.leads ?? []), ...page.items] : page.items,
            cursor: page.nextCursor,
            loading: false,
          },
        }));
      } catch (e) {
        toast(problemMessage(e));
        setColumns((c) => ({
          ...c,
          [stageId]: { ...(c[stageId] ?? { leads: [], cursor: null }), loading: false },
        }));
      }
    },
    [orgId, query],
  );

  useEffect(() => {
    const timer = setTimeout(
      () => stages.forEach((s) => void loadColumn(s.id, null)),
      filters.q ? 250 : 0,
    );
    return () => clearTimeout(timer);
  }, [stages, loadColumn, filters.q]);

  useEffect(() => {
    if (!focusAfterMove.current) return;
    const handle = document.querySelector<HTMLButtonElement>(
      `[data-move-handle="${focusAfterMove.current}"]`,
    );
    handle?.focus();
    focusAfterMove.current = null;
  });

  const find = (leadId: string, from: string) => columns[from]?.leads.find((l) => l.id === leadId);

  async function move(
    leadId: string,
    from: string,
    to: string,
    extra: { lossReasonId?: string; dealValue?: number } = {},
  ) {
    if (from === to) return;
    const lead = find(leadId, from);
    const stage = lookups.stageById.get(to);
    if (!lead || !stage) return;
    if (
      needsCloseDialog(stage, extra.dealValue ?? lead.dealValue, wonRequiresDealValue) &&
      !extra.lossReasonId &&
      !extra.dealValue
    ) {
      setClosing({ leadId, from, leadName: lead.name, stage, dealValue: lead.dealValue });
      return;
    }
    // Optimistic: the card moves now and comes back if the API refuses (PIPE-02).
    const snapshot = columns;
    const moved = {
      ...lead,
      stageId: to,
      ...(extra.dealValue ? { dealValue: extra.dealValue } : {}),
      stuck: false,
    };
    setColumns((c) => ({
      ...c,
      [from]: { ...c[from]!, leads: c[from]!.leads.filter((l) => l.id !== leadId) },
      [to]: {
        ...(c[to] ?? { cursor: null, loading: false, leads: [] }),
        leads: [moved, ...(c[to]?.leads ?? [])],
      },
    }));
    focusAfterMove.current = leadId;
    setAnnouncement(`${lead.name} moved to ${stage.name}`);
    try {
      const updated = await api<LeadSummaryDto>(`/v1/orgs/${orgId}/leads/${leadId}`, {
        method: 'PATCH',
        body: { stageId: to, ...extra },
      });
      setColumns((c) => ({
        ...c,
        [to]: {
          ...c[to]!,
          leads: c[to]!.leads.map((l) => (l.id === leadId ? { ...l, ...pickSummary(updated) } : l)),
        },
      }));
    } catch (e) {
      setColumns(snapshot);
      focusAfterMove.current = leadId;
      setAnnouncement(
        `${lead.name} could not move. It is back in ${lookups.stageById.get(from)?.name ?? 'its stage'}`,
      );
      toast(`${lead.name} could not move. ${problemMessage(e)}`);
    }
  }

  function onDragEnd(event: DragEndEvent) {
    const from = event.active.data.current?.stageId as string | undefined;
    const to = event.over?.id as string | undefined;
    if (from && to) void move(String(event.active.id), from, to);
  }

  function onHandleKey(
    event: KeyboardEvent<HTMLButtonElement>,
    lead: LeadSummaryDto,
    stageId: string,
  ) {
    const index = stages.findIndex((s) => s.id === (picked?.target ?? stageId));
    if (!picked || picked.leadId !== lead.id) {
      if (event.key === ' ' || event.key === 'Enter') {
        event.preventDefault();
        setPicked({ leadId: lead.id, from: stageId, target: stageId });
        setAnnouncement(
          `Picked up ${lead.name} in ${stages[index]?.name}. Use the left and right arrow keys to choose a stage, Space to drop, Escape to cancel.`,
        );
      }
      return;
    }
    if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') {
      event.preventDefault();
      const next = Math.min(
        stages.length - 1,
        Math.max(0, index + (event.key === 'ArrowRight' ? 1 : -1)),
      );
      setPicked({ ...picked, target: stages[next]!.id });
      setAnnouncement(`${stages[next]!.name}, stage ${next + 1} of ${stages.length}`);
    } else if (event.key === ' ' || event.key === 'Enter') {
      event.preventDefault();
      setPicked(null);
      if (picked.target === picked.from)
        setAnnouncement(`${lead.name} stays in ${stages[index]?.name}`);
      else void move(lead.id, picked.from, picked.target);
    } else if (event.key === 'Escape') {
      event.preventDefault();
      setPicked(null);
      setAnnouncement(`Move cancelled. ${lead.name} stays where it was`);
    }
  }

  return (
    <>
      <p id="board-instructions" className="sr-only">
        To move a lead with the keyboard, focus its move button and press Space. Choose a stage with
        the left and right arrow keys, then press Space again.
      </p>
      <div aria-live="assertive" className="sr-only">
        {announcement}
      </div>
      <DndContext sensors={sensors} onDragEnd={onDragEnd}>
        <div className="-mx-4 overflow-x-auto px-4 pb-4 lg:-mx-6 lg:px-6">
          <div className="flex gap-4" style={{ minWidth: `${stages.length * 18.5}rem` }}>
            {stages.map((stage) => (
              <BoardColumn
                key={stage.id}
                stage={stage}
                column={columns[stage.id]}
                isKeyboardTarget={
                  picked !== null && picked.target === stage.id && picked.target !== picked.from
                }
                onLoadMore={() => loadColumn(stage.id, columns[stage.id]?.cursor ?? null)}
              >
                {(columns[stage.id]?.leads ?? []).map((lead) => (
                  <BoardCard
                    key={lead.id}
                    lead={lead}
                    stageId={stage.id}
                    slug={slug}
                    picked={picked?.leadId === lead.id}
                    onKeyDown={(e) => onHandleKey(e, lead, stage.id)}
                    onBlur={() => picked?.leadId === lead.id && setPicked(null)}
                  />
                ))}
              </BoardColumn>
            ))}
          </div>
        </div>
      </DndContext>
      <CloseDialog
        request={closing}
        lossReasons={lookups.lossReasons}
        currency={currency}
        onDone={(extra) => {
          const request = closing;
          setClosing(null);
          if (request && extra) void move(request.leadId, request.from, request.stage.id, extra);
          else if (request) focusAfterMove.current = request.leadId;
        }}
      />
    </>
  );
}

function pickSummary(lead: LeadSummaryDto): Partial<LeadSummaryDto> {
  const { id: _id, ...rest } = lead;
  return rest;
}

function BoardColumn({
  stage,
  column,
  isKeyboardTarget,
  onLoadMore,
  children,
}: {
  stage: StageDto;
  column: Column | undefined;
  isKeyboardTarget: boolean;
  onLoadMore: () => void;
  children: React.ReactNode;
}) {
  const { setNodeRef, isOver } = useDroppable({ id: stage.id });
  const count = column?.leads.length ?? 0;
  return (
    <section
      ref={setNodeRef}
      aria-label={`${stage.name} stage`}
      data-stage={stage.id}
      className={cn(
        'flex w-72 shrink-0 flex-col gap-3 rounded-cards bg-limestone p-4 outline-offset-2 transition-[outline-color] duration-150',
        (isOver || isKeyboardTarget) && 'outline-2 outline-dotted outline-obsidian',
      )}
    >
      <header className="flex items-baseline justify-between gap-2 px-2 pt-2">
        <h2 className="text-body">{stage.name}</h2>
        <span className="caption tabular text-obsidian/75">
          {column?.cursor ? `${count}+` : count}
          {stage.kind === 'OPEN' ? ` · ${stage.slaHours} h SLA` : ''}
        </span>
      </header>
      <ul className="flex min-h-24 flex-col gap-2" aria-label={`Leads in ${stage.name}`}>
        {children}
      </ul>
      {column?.cursor ? (
        <Button variant="ghost" size="sm" loading={column.loading} onClick={onLoadMore}>
          Show more
        </Button>
      ) : null}
      {!column ? <p className="caption px-2">Loading</p> : null}
    </section>
  );
}

function BoardCard({
  lead,
  stageId,
  slug,
  picked,
  onKeyDown,
  onBlur,
}: {
  lead: LeadSummaryDto;
  stageId: string;
  slug: string;
  picked: boolean;
  onKeyDown: (e: KeyboardEvent<HTMLButtonElement>) => void;
  onBlur: () => void;
}) {
  const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({
    id: lead.id,
    data: { stageId },
  });
  return (
    <li
      ref={setNodeRef}
      {...listeners}
      style={
        transform ? { transform: `translate3d(${transform.x}px, ${transform.y}px, 0)` } : undefined
      }
      className={cn(
        'flex touch-none gap-2 rounded-medium bg-pumice p-3 pl-1',
        isDragging && 'relative z-20 cursor-grabbing opacity-90',
        picked && 'outline-2 outline-obsidian',
      )}
      data-lead={lead.id}
    >
      <button
        type="button"
        {...attributes}
        role="button"
        tabIndex={0}
        aria-roledescription="movable lead"
        aria-describedby="board-instructions"
        aria-pressed={picked}
        data-move-handle={lead.id}
        onKeyDown={onKeyDown}
        onBlur={onBlur}
        className="flex w-8 shrink-0 cursor-grab items-start justify-center self-stretch rounded-small pt-1"
      >
        <GripVertical aria-hidden className="size-4" strokeWidth={1.75} />
        <span className="sr-only">Move {lead.name}</span>
      </button>
      <div className="min-w-0 flex-1">
        <Link
          href={`/app/${slug}/leads/${lead.id}`}
          className="block truncate rounded-small underline-offset-4 hover:underline"
        >
          {lead.name}
        </Link>
        {lead.company ? (
          <p className="truncate text-body-sm text-obsidian/75">{lead.company}</p>
        ) : null}
        <p className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-body-sm">
          <span className="text-obsidian/80">{lead.ownerName ?? 'Unassigned'}</span>
          {lead.dealValue ? (
            <span className="tabular">{formatMoney(lead.dealValue, lead.currency)}</span>
          ) : null}
        </p>
        <div className="mt-2 flex flex-wrap gap-1 empty:hidden">
          <LeadBadges lead={lead} />
        </div>
      </div>
    </li>
  );
}
