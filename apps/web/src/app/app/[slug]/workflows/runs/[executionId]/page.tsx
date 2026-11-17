import { RunDetail } from './run-detail';

export default async function RunPage({
  params,
}: PageProps<'/app/[slug]/workflows/runs/[executionId]'>) {
  const { executionId } = await params;
  return <RunDetail executionId={executionId} />;
}
