'use client';

import { PRIORITY_LABEL, SOURCE_LABEL } from '@datoflow/domain';
import { LEAD_SOURCES, PRIORITIES, type LeadFilters } from '@datoflow/shared';
import { Button, Field, Input, Select } from '@datoflow/ui';
import { ChevronDown, Search, SlidersHorizontal, X } from 'lucide-react';
import { useState } from 'react';
import type { Lookups } from '@/lib/lookups';

/** The filters as a query string for GET …/leads. */
export function filtersToQuery(filters: LeadFilters, extra: Record<string, string> = {}): string {
  const params = new URLSearchParams();
  if (filters.q) params.set('q', filters.q);
  for (const key of ['owner', 'stage', 'source', 'priority'] as const) {
    const values = filters[key];
    if (values?.length) params.set(key, values.join(','));
  }
  if (filters.createdFrom) params.set('createdFrom', filters.createdFrom);
  if (filters.createdTo) params.set('createdTo', filters.createdTo);
  if (filters.stuck) params.set('stuck', 'true');
  if (filters.status && filters.status !== 'all') params.set('status', filters.status);
  if (filters.archived) params.set('archived', 'true');
  if (filters.sort) params.set('sort', filters.sort);
  for (const [k, v] of Object.entries(extra)) params.set(k, v);
  return params.toString();
}

/** Filters inside the folded panel, so the button can say how many are on. */
export function panelFilterCount(f: LeadFilters) {
  return [
    f.owner?.length,
    f.stage?.length,
    f.source?.length,
    f.priority?.length,
    f.createdFrom,
    f.createdTo,
    f.archived,
    f.status && f.status !== 'all',
  ].filter(Boolean).length;
}

export function activeFilterCount(f: LeadFilters) {
  return panelFilterCount(f) + [f.q, f.stuck].filter(Boolean).length;
}

function single(values: string[] | undefined) {
  return values?.[0] ?? '';
}

export function FilterBar({
  filters,
  onChange,
  lookups,
  showStage,
  canSeeArchived,
}: {
  filters: LeadFilters;
  onChange: (next: LeadFilters) => void;
  lookups: Lookups;
  showStage: boolean;
  canSeeArchived: boolean;
}) {
  const set = (patch: Partial<LeadFilters>) => onChange({ ...filters, ...patch });
  const list = (value: string) => (value ? [value] : undefined);

  const [open, setOpen] = useState(false);
  const inPanel = panelFilterCount(filters);

  return (
    <form
      role="search"
      aria-label="Filter leads"
      onSubmit={(e) => e.preventDefault()}
      className="flex flex-col gap-3 rounded-cards bg-limestone p-4 sm:p-6"
    >
      <div className="flex flex-wrap items-end gap-3">
        <div className="relative min-w-60 flex-1">
          <Field label="Search">
            <Input
              type="search"
              className="pl-11"
              value={filters.q ?? ''}
              onChange={(e) => set({ q: e.target.value || undefined })}
            />
          </Field>
          <Search
            aria-hidden
            strokeWidth={1.75}
            className="pointer-events-none absolute bottom-4 left-5 size-4"
          />
        </div>
        <label className="flex min-h-12 cursor-pointer items-center gap-3 rounded-pills bg-pumice px-5">
          <input
            type="checkbox"
            className="size-5 accent-obsidian"
            checked={Boolean(filters.stuck)}
            onChange={(e) => set({ stuck: e.target.checked || undefined })}
          />
          Stuck only
        </label>
        <Button
          type="button"
          variant="secondary"
          aria-expanded={open}
          aria-controls="lead-filter-panel"
          onClick={() => setOpen((o) => !o)}
        >
          <SlidersHorizontal aria-hidden className="size-4" strokeWidth={1.75} />
          Filters{inPanel ? <span className="tabular"> · {inPanel}</span> : null}
          <ChevronDown
            aria-hidden
            className={`size-4 transition-transform duration-150 ${open ? 'rotate-180' : ''}`}
            strokeWidth={1.75}
          />
        </Button>
        {activeFilterCount(filters) > 0 ? (
          <Button type="button" variant="ghost" onClick={() => onChange({ sort: filters.sort })}>
            <X aria-hidden className="size-4" strokeWidth={1.75} />
            Clear
          </Button>
        ) : null}
      </div>
      <div
        id="lead-filter-panel"
        hidden={!open}
        className="grid gap-3 border-t-[1.5px] border-dotted border-obsidian pt-4 sm:grid-cols-2 lg:grid-cols-4"
      >
        <Field label="Owner">
          <Select
            value={single(filters.owner)}
            onChange={(e) => set({ owner: list(e.target.value) })}
          >
            <option value="">Anyone</option>
            <option value="me">Me</option>
            <option value="none">Unassigned</option>
            {lookups.assignees.map((a) => (
              <option key={a.userId} value={a.userId}>
                {a.name}
              </option>
            ))}
          </Select>
        </Field>
        {showStage ? (
          <Field label="Stage">
            <Select
              value={single(filters.stage)}
              onChange={(e) => set({ stage: list(e.target.value) })}
            >
              <option value="">Any stage</option>
              {lookups.stages.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </Select>
          </Field>
        ) : null}
        {showStage ? (
          <Field label="Status">
            <Select
              value={filters.status ?? 'all'}
              onChange={(e) => set({ status: e.target.value as LeadFilters['status'] })}
            >
              <option value="all">Open and closed</option>
              <option value="open">Open only</option>
            </Select>
          </Field>
        ) : null}
        <Field label="Source">
          <Select
            value={single(filters.source)}
            onChange={(e) => set({ source: list(e.target.value) as LeadFilters['source'] })}
          >
            <option value="">Any source</option>
            {LEAD_SOURCES.map((s) => (
              <option key={s} value={s}>
                {SOURCE_LABEL[s]}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Priority">
          <Select
            value={single(filters.priority)}
            onChange={(e) => set({ priority: list(e.target.value) as LeadFilters['priority'] })}
          >
            <option value="">Any priority</option>
            {PRIORITIES.map((p) => (
              <option key={p} value={p}>
                {PRIORITY_LABEL[p]}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Created from">
          <Input
            type="date"
            value={filters.createdFrom ?? ''}
            onChange={(e) => set({ createdFrom: e.target.value || undefined })}
          />
        </Field>
        <Field label="Created to">
          <Input
            type="date"
            value={filters.createdTo ?? ''}
            onChange={(e) => set({ createdTo: e.target.value || undefined })}
          />
        </Field>
        {canSeeArchived ? (
          <label className="flex min-h-12 cursor-pointer items-center gap-3 self-end rounded-pills bg-pumice px-5">
            <input
              type="checkbox"
              className="size-5 accent-obsidian"
              checked={Boolean(filters.archived)}
              onChange={(e) => set({ archived: e.target.checked || undefined })}
            />
            Archived
          </label>
        ) : null}
      </div>
    </form>
  );
}
