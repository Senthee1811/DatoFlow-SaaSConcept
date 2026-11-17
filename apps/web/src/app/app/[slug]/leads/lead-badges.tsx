import type { LeadSummaryDto } from '@datoflow/shared';
import { Badge, StatusBadge } from '@datoflow/ui';

/** Why a lead is stuck, in words. */
export function stuckText(reasons: LeadSummaryDto['stuckReasons']): string {
  if (reasons.includes('NEXT_STEP_OVERDUE') && reasons.includes('SLA'))
    return 'Stuck: overdue and quiet';
  if (reasons.includes('NEXT_STEP_OVERDUE')) return 'Stuck: next step overdue';
  return 'Stuck: no activity';
}

/** Status badges for a lead. Each carries a word, never colour alone. */
export function LeadBadges({ lead }: { lead: LeadSummaryDto }) {
  return (
    <>
      {lead.stuck ? (
        <StatusBadge status="attention">{stuckText(lead.stuckReasons)}</StatusBadge>
      ) : null}
      {lead.priority === 'HIGH' ? <Badge tone="sulfur">High priority</Badge> : null}
      {lead.isSample ? <Badge tone="limestone">Sample</Badge> : null}
      {lead.archivedAt ? <Badge tone="limestone">Archived</Badge> : null}
    </>
  );
}
