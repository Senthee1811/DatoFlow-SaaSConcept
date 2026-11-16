import type { Metadata } from 'next';
import { SignInForm } from './sign-in-form';

export const metadata: Metadata = { title: 'Sign in' };

export default async function SignInPage({ searchParams }: PageProps<'/sign-in'>) {
  const params = await searchParams;
  const next = typeof params.next === 'string' ? params.next : undefined;
  const email = typeof params.email === 'string' ? params.email : undefined;
  return (
    <>
      <h1 className="display mb-8 text-heading-lg">Sign in</h1>
      <SignInForm next={next} defaultEmail={email} google={Boolean(process.env.GOOGLE_CLIENT_ID)} />
    </>
  );
}
