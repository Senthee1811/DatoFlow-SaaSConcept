import type { Metadata } from 'next';
import { InviteView } from './invite-view';

export const metadata: Metadata = { title: 'Invitation' };

export default async function InvitePage({ params }: PageProps<'/invite/[token]'>) {
  const { token } = await params;
  return <InviteView token={token} />;
}
