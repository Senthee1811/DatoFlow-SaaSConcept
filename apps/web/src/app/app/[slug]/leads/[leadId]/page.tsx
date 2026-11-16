import { LeadDetail } from './lead-detail';

export default async function LeadPage({ params }: PageProps<'/app/[slug]/leads/[leadId]'>) {
  const { leadId } = await params;
  return <LeadDetail leadId={leadId} />;
}
