import type { Metadata } from 'next';
import { SignUpForm } from './sign-up-form';

export const metadata: Metadata = { title: 'Create an account' };

export default async function SignUpPage({ searchParams }: PageProps<'/sign-up'>) {
  const params = await searchParams;
  const next = typeof params.next === 'string' ? params.next : undefined;
  const email = typeof params.email === 'string' ? params.email : undefined;
  return (
    <>
      <h1 className="display mb-3 text-heading-lg">Create an account</h1>
      <p className="mb-8 max-w-md text-obsidian/80">
        Set up your workspace, then bring in your team and your leads.
      </p>
      <SignUpForm next={next} defaultEmail={email} google={Boolean(process.env.GOOGLE_CLIENT_ID)} />
    </>
  );
}
