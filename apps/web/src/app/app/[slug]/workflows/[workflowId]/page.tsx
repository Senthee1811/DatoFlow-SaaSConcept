import { WorkflowDetail } from './workflow-detail';

export default async function WorkflowPage({
  params,
}: PageProps<'/app/[slug]/workflows/[workflowId]'>) {
  const { workflowId } = await params;
  return <WorkflowDetail workflowId={workflowId} />;
}
