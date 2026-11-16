import { MailCheck } from 'lucide-react';
import type { Metadata } from 'next';
import Link from 'next/link';

export const metadata: Metadata = { title: 'Check your email' };

export default async function CheckEmailPage({ searchParams }: PageProps<'/check-email'>) {
  const { email } = await searchParams;
  const address = typeof email === 'string' ? email : null;
  return (
    <>
      <MailCheck aria-hidden className="mb-6 size-8" strokeWidth={1.5} />
      <h1 className="display mb-4 text-heading-lg">Check your email</h1>
      <p className="mb-8 max-w-md">
        We sent a confirmation link to{' '}
        {address ? <strong className="font-medium">{address}</strong> : 'your inbox'}. Open it to
        finish setting up your account. The link works for 24 hours.
      </p>
      <Link href="/sign-in" className="text-body-sm underline decoration-dotted underline-offset-4">
        Back to sign in
      </Link>
    </>
  );
}
