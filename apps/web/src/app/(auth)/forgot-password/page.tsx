'use client';

import { Button, Field, Input } from '@datoflow/ui';
import Link from 'next/link';
import { useState, type FormEvent } from 'react';
import { authClient } from '@/lib/auth-client';

export default function ForgotPasswordPage() {
  const [email, setEmail] = useState('');
  const [state, setState] = useState<'idle' | 'sending' | 'sent' | 'limited'>('idle');

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    setState('sending');
    const { error } = await authClient.requestPasswordReset({
      email,
      redirectTo: '/reset-password',
    });
    // The same answer whether or not the address has an account.
    setState(error?.status === 429 ? 'limited' : 'sent');
  }

  if (state === 'sent') {
    return (
      <>
        <h1 className="display mb-4 text-heading-lg">Check your email</h1>
        <p className="mb-8 max-w-md">
          If an account uses {email}, a reset link is on its way. It works once, within 30 minutes.
        </p>
        <Link
          href="/sign-in"
          className="text-body-sm underline decoration-dotted underline-offset-4"
        >
          Back to sign in
        </Link>
      </>
    );
  }

  return (
    <>
      <h1 className="display mb-3 text-heading-lg">Reset your password</h1>
      <p className="mb-8 max-w-md text-obsidian/80">We will email you a link to set a new one.</p>
      <form onSubmit={onSubmit} className="flex flex-col gap-4">
        <Field label="Email">
          <Input
            type="email"
            autoComplete="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
        </Field>
        {state === 'limited' ? (
          <p role="alert" className="rounded-medium bg-sulfur px-5 py-3 text-body-sm">
            Too many reset requests for this email. Try again in an hour
          </p>
        ) : null}
        <div className="flex flex-wrap items-center gap-2 pt-2">
          <Button type="submit" loading={state === 'sending'}>
            Send reset link
          </Button>
          <Link
            href="/sign-in"
            className="px-3 text-body-sm underline decoration-dotted underline-offset-4"
          >
            Back to sign in
          </Link>
        </div>
      </form>
    </>
  );
}
