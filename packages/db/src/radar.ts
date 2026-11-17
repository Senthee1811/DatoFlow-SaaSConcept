import type { Tx } from './client.js';
import { Prisma } from './generated/prisma/client.js';

/** How the radar appears on the timeline. */
export const RADAR_ACTOR = 'Stuck-lead radar';

export interface RadarScope {
  /** Only these leads. Omit for every lead the transaction can see. */
  leadIds?: string[];
  /** Only this organization. Tenant transactions are already limited by row-level security. */
  organizationId?: string;
}

function filters(scope: RadarScope, alias: string): Prisma.Sql {
  const parts: Prisma.Sql[] = [];
  if (scope.leadIds)
    parts.push(Prisma.sql`AND ${Prisma.raw(`${alias}."id"`)} = ANY(${scope.leadIds}::text[])`);
  if (scope.organizationId)
    parts.push(
      Prisma.sql`AND ${Prisma.raw(`${alias}."organizationId"`)} = ${scope.organizationId}`,
    );
  return parts.length ? Prisma.join(parts, ' ') : Prisma.empty;
}

/**
 * Recomputes each lead's earliest next step: the earliest open task with an assignee, for open,
 * unarchived leads only. Runs after every task change, stage move and archive.
 */
export async function refreshNextSteps(tx: Tx, scope: RadarScope): Promise<void> {
  await tx.$executeRaw`
    UPDATE "Lead" l
    SET "nextStepDueAt" = CASE
      WHEN l."archivedAt" IS NULL AND s.kind = 'OPEN' THEN (
        SELECT min(t."dueAt") FROM "Task" t
        WHERE t."leadId" = l.id AND t.status = 'OPEN' AND t."assigneeId" IS NOT NULL
      )
    END
    FROM "PipelineStage" s
    WHERE s.id = l."stageId" ${filters(scope, 'l')}`;
}

/**
 * The stuck-lead radar (TASK-03). Flags open, unarchived leads with no activity past their stage
 * SLA or with an overdue next step, and writes one STUCK entry on the timeline each time a lead
 * becomes stuck. Clears the flag on leads that recovered. The rule is the same as
 * `stuckReasons` in packages/domain, in SQL so one statement covers every lead.
 */
export async function runRadar(
  tx: Tx,
  now: Date,
  scope: RadarScope = {},
): Promise<{ flagged: number; cleared: number }> {
  const flagged = await tx.$executeRaw`
    WITH newly AS (
      UPDATE "Lead" l SET "stuckAt" = ${now}
      FROM "PipelineStage" s
      WHERE s.id = l."stageId" AND s.kind = 'OPEN'
        AND l."stuckAt" IS NULL AND l."archivedAt" IS NULL
        AND (l."slaDueAt" < ${now} OR l."nextStepDueAt" < ${now})
        ${filters(scope, 'l')}
      RETURNING l.id, l."organizationId", l."slaDueAt", l."nextStepDueAt"
    )
    INSERT INTO "LeadActivity" (id, "organizationId", "leadId", type, "actorType", "actorLabel", payload, "occurredAt")
    SELECT gen_random_uuid()::text, "organizationId", id, 'STUCK', 'SYSTEM', ${RADAR_ACTOR},
      jsonb_build_object('reasons', to_jsonb(array_remove(ARRAY[
        CASE WHEN "slaDueAt" < ${now} THEN 'SLA' END,
        CASE WHEN "nextStepDueAt" < ${now} THEN 'NEXT_STEP_OVERDUE' END
      ], NULL))),
      ${now}
    FROM newly`;
  const cleared = await tx.$executeRaw`
    UPDATE "Lead" l SET "stuckAt" = NULL
    FROM "PipelineStage" s
    WHERE s.id = l."stageId" AND l."stuckAt" IS NOT NULL
      -- coalesce: a missing deadline is not a missed one (NOT of NULL would match nothing).
      AND NOT (
        s.kind = 'OPEN' AND l."archivedAt" IS NULL
        AND (coalesce(l."slaDueAt" < ${now}, false) OR coalesce(l."nextStepDueAt" < ${now}, false))
      )
      ${filters(scope, 'l')}`;
  return { flagged, cleared };
}

/** After a change to a lead or its tasks: recompute its next step, then run the radar on it. */
export async function refreshLeads(tx: Tx, leadIds: string[], now = new Date()) {
  if (leadIds.length === 0) return { flagged: 0, cleared: 0 };
  await refreshNextSteps(tx, { leadIds });
  return runRadar(tx, now, { leadIds });
}
