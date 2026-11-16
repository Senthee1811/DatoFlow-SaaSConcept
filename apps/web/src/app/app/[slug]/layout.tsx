import type { ReactNode } from 'react';
import { WorkspaceShell } from './workspace-shell';

export default async function WorkspaceLayout({ children, params }: LayoutProps<'/app/[slug]'>) {
  const { slug } = await params;
  return <WorkspaceShell slug={slug}>{children as ReactNode}</WorkspaceShell>;
}
