'use client';

import { Button, Field, Input } from '@datoflow/ui';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { Suspense, useState, type FormEvent } from 'react';
import { authClient } from '@/lib/auth-client';

function ResetForm() {
  const params = useSearchParams();
  const token = params.get('token');
  const [password, setPassword] = useState('');
  const [state, setState] = useState<'idle' | 'saving' | 'done' | 'failed'>(
    params.get('error') ? 'failed' : 'idle',
  );

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    if (!token) return setState('failed');
    setState('saving');
    const { error } = await authClient.resetPassword({ newPassword: password, token });
    setState(error ? 'failed' : 'done');
  }

  if (state === 'done') {
    return (
      <>
        <h1 className="display mb-4 text-heading-lg">Password changed</h1>
        <p className="mb-8 max-w-md">
          You are signed out everywhere. Sign in with your new password.
        </p>
        <Link
          href="/sign-in"
          className="text-body-sm underline decoration-dotted underline-offset-4"
        >
          Sign in
        </Link>
      </>
    );
  }

  if (!token || state === 'failed') {
    return (
      <>
        <h1 className="display mb-4 text-heading-lg">This link has expired</h1>
        <p className="mb-8 max-w-md">
          Reset links work once, within 30 minutes. Ask for a new one.
        </p>
        <Link
          href="/forgot-password"
          className="text-body-sm underline decoration-dotted underline-offset-4"
        >
          Send a new link
        </Link>
      </>
    );
  }

  return (
    <>
      <h1 className="display mb-8 text-heading-lg">Choose a new password</h1>
      <form onSubmit={onSubmit} className="flex flex-col gap-4">
        <Field label="New password" hint="At least 10 characters">
          <Input
            type="password"
            autoComplete="new-password"
            minLength={10}
            maxLength={128}
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </Field>
        <div className="pt-2">
          <Button type="submit" loading={state === 'saving'}>
            Save password
          </Button>
        </div>
      </form>
    </>
  );
}

export default function ResetPasswordPage() {
  return (
    <Suspense>
      <ResetForm />
    </Suspense>
  );
}
