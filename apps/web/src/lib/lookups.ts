'use client';

import type { AssigneeDto, LossReasonDto, PipelineDto, StageDto } from '@datoflow/shared';
import { useCallback, useEffect, useState } from 'react';
import { api, problemMessage } from './api';

export interface Lookups {
  pipeline: PipelineDto;
  stages: StageDto[];
  stageById: Map<string, StageDto>;
  assignees: AssigneeDto[];
  assigneeById: Map<string, AssigneeDto>;
  lossReasons: LossReasonDto[];
}

/** Stages, members and loss reasons for an organization, loaded once per screen. */
export function useLookups(orgId: string) {
  const [lookups, setLookups] = useState<Lookups | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [pipelines, assignees, reasons] = await Promise.all([
        api<{ items: PipelineDto[] }>(`/v1/orgs/${orgId}/pipelines`),
        api<{ items: AssigneeDto[] }>(`/v1/orgs/${orgId}/assignees`),
        api<{ items: LossReasonDto[] }>(`/v1/orgs/${orgId}/loss-reasons`),
      ]);
      const pipeline = pipelines.items[0]!;
      setLookups({
        pipeline,
        stages: pipeline.stages,
        stageById: new Map(pipeline.stages.map((s) => [s.id, s])),
        assignees: assignees.items,
        assigneeById: new Map(assignees.items.map((a) => [a.userId, a])),
        lossReasons: reasons.items.filter((r) => r.active),
      });
    } catch (e) {
      setError(problemMessage(e));
    }
  }, [orgId]);

  useEffect(() => {
    void load();
  }, [load]);

  return { lookups, error, reload: load };
}

export function formatMoney(value: number | null, currency: string) {
  if (value === null) return '';
  return new Intl.NumberFormat('en-GB', {
    style: 'currency',
    currency,
    maximumFractionDigits: 0,
  }).format(value);
}
