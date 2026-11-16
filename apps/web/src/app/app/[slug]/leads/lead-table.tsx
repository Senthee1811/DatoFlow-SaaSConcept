'use client';

import { PRIORITY_LABEL, SOURCE_LABEL } from '@datoflow/domain';
import type { LeadFilters, LeadSummaryDto, Page } from '@datoflow/shared';
import { Button, Select } from '@datoflow/ui';
import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { api, problemMessage } from '@/lib/api';
import { formatMoney, type Lookups } from '@/lib/lookups';
import { formatInOrgTime } from '@/lib/org-context';
import { filtersToQuery } from './filters';
import { LeadBadges } from './lead-badges';

const SORTS: { value: NonNullable<LeadFilters['sort']>; label: string }[] = [
  { value: 'created_desc', label: 'Newest first' },
  { value: 'sla_asc', label: 'Closest to stuck' },
  { value: 'updated_desc', label: 'Recently changed' },
  { value: 'value_desc', label: 'Highest value' },
  { value: 'name_asc', label: 'Name A to Z' },
  { value: 'created_asc', label: 'Oldest first' },
];

export function LeadTable({
  orgId,
  slug,
  timezone,
  filters,
  onSort,
  lookups,
}: {
  orgId: string;
  slug: string;
  timezone: string;
  filters: LeadFilters;
  onSort: (sort: NonNullable<LeadFilters['sort']>) => void;
  lookups: Lookups;
}) {
  const [rows, setRows] = useState<LeadSummaryDto[] | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const query = filtersToQuery(filters, { limit: '50' });

  const load = useCallback(
    async (after: string | null) => {
      setLoading(true);
      setError(null);
      try {
        const page = await api<Page<LeadSummaryDto>>(
          `/v1/orgs/${orgId}/leads?${query}${after ? `&cursor=${after}` : ''}`,
        );
        setRows((prev) => (after && prev ? [...prev, ...page.items] : page.items));
        setCursor(page.nextCursor);
      } catch (e) {
        setError(problemMessage(e));
      } finally {
        setLoading(false);
      }
    },
    [orgId, query],
  );

  useEffect(() => {
    // Typing in search waits a moment before asking the API.
    const timer = setTimeout(() => void load(null), filters.q ? 250 : 0);
    return () => clearTimeout(timer);
  }, [load, filters.q]);

  return (
    <section aria-label="Lead list" className="rounded-cards bg-limestone p-4 sm:p-6">
      <div className="mb-4 flex flex-wrap items-end justify-end gap-3 px-2">
        <div className="w-full sm:w-60">
          <label htmlFor="lead-sort" className="sr-only">
            Sort
          </label>
          <Select
            id="lead-sort"
            className="min-h-11"
            value={filters.sort ?? 'created_desc'}
            onChange={(e) => onSort(e.target.value as NonNullable<LeadFilters['sort']>)}
          >
            {SORTS.map((s) => (
              <option key={s.value} value={s.value}>
                {s.label}
              </option>
            ))}
          </Select>
        </div>
      </div>
      {error ? (
        <p role="alert" className="px-2">
          {error}
        </p>
      ) : null}
      {!rows ? (
        <p aria-live="polite" className="px-2 py-6">
          Loading leads
        </p>
      ) : rows.length === 0 ? (
        <p className="px-2 py-6">No leads match these filters</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[56rem] border-collapse text-left">
            <thead>
              <tr className="text-body-sm">
                <th scope="col" className="px-3 py-3 font-medium">
                  Lead
                </th>
                <th scope="col" className="px-3 py-3 font-medium">
                  Stage
                </th>
                <th scope="col" className="px-3 py-3 font-medium">
                  Owner
                </th>
                <th scope="col" className="px-3 py-3 font-medium">
                  Source
                </th>
                <th scope="col" className="px-3 py-3 font-medium">
                  Priority
                </th>
                <th scope="col" className="px-3 py-3 text-right font-medium">
                  Value
                </th>
                <th scope="col" className="px-3 py-3 font-medium">
                  Created
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((lead) => (
                <tr
                  key={lead.id}
                  className="border-t-[1.5px] border-dotted border-obsidian align-top"
                >
                  <td className="px-3 py-3">
                    <Link
                      href={`/app/${slug}/leads/${lead.id}`}
                      className="rounded-small underline-offset-4 hover:underline"
                    >
                      {lead.name}
                    </Link>
                    {lead.company ? (
                      <span className="block text-body-sm text-obsidian/75">{lead.company}</span>
                    ) : null}
                    <span className="mt-1 flex flex-wrap gap-1">
                      <LeadBadges lead={lead} />
                    </span>
                  </td>
                  <td className="px-3 py-3">{lookups.stageById.get(lead.stageId)?.name ?? ''}</td>
                  <td className="px-3 py-3">
                    {lead.ownerName ?? <span className="text-obsidian/75">Unassigned</span>}
                  </td>
                  <td className="px-3 py-3">{SOURCE_LABEL[lead.source]}</td>
                  <td className="px-3 py-3">{PRIORITY_LABEL[lead.priority]}</td>
                  <td className="tabular px-3 py-3 text-right">
                    {formatMoney(lead.dealValue, lead.currency)}
                  </td>
                  <td className="tabular px-3 py-3 text-body-sm">
                    {formatInOrgTime(lead.createdAt, timezone, {
                      hour: undefined,
                      minute: undefined,
                    })}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {cursor ? (
        <div className="mt-4 px-2">
          <Button variant="secondary" loading={loading} onClick={() => load(cursor)}>
            Load more
          </Button>
        </div>
      ) : null}
    </section>
  );
}
