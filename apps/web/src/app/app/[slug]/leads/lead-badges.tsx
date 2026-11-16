import type { LeadSummaryDto } from '@datoflow/shared';
import { Badge, StatusBadge } from '@datoflow/ui';

/** Status badges for a lead. Each carries a word, never colour alone. */
export function LeadBadges({ lead }: { lead: LeadSummaryDto }) {
  return (
    <>
      {lead.stuck ? <StatusBadge status="attention">Stuck</StatusBadge> : null}
      {lead.priority === 'HIGH' ? <Badge tone="sulfur">High priority</Badge> : null}
      {lead.isSample ? <Badge tone="limestone">Sample</Badge> : null}
      {lead.archivedAt ? <Badge tone="limestone">Archived</Badge> : null}
    </>
  );
}
