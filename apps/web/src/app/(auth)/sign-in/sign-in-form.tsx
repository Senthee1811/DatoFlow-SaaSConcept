'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import { Button, Divider, Field, Input, buttonClass } from '@datoflow/ui';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { authClient } from '@/lib/auth-client';
import { safeNext } from '@/lib/redirect';

const schema = z.object({
  email: z.email('Enter an email address'),
  password: z.string().min(1, 'Enter your password'),
});
type Values = z.infer<typeof schema>;

export function SignInForm({
  next,
  defaultEmail,
  google,
}: {
  next?: string;
  defaultEmail?: string;
  google: boolean;
}) {
  const router = useRouter();
  const destination = safeNext(next);
  const [error, setError] = useState<string | null>(null);
  const form = useForm<Values>({
    resolver: zodResolver(schema),
    defaultValues: { email: defaultEmail ?? '', password: '' },
  });

  async function onSubmit(values: Values) {
    setError(null);
    const { error: authError } = await authClient.signIn.email({
      ...values,
      callbackURL: destination,
    });
    if (!authError) {
      router.replace(destination);
      router.refresh();
      return;
    }
    if (authError.status === 403)
      setError('Confirm your email first. We sent you a link when you signed up');
    else if (authError.status === 429) setError('Too many attempts. Wait a minute and try again');
    else setError('That email and password do not match');
  }

  const { errors, isSubmitting } = form.formState;
  const query = next ? `?next=${encodeURIComponent(destination)}` : '';

  return (
    <div className="flex flex-col gap-6">
      <form noValidate onSubmit={form.handleSubmit(onSubmit)} className="flex flex-col gap-4">
        <Field label="Email" error={errors.email?.message}>
          <Input type="email" autoComplete="email" {...form.register('email')} />
        </Field>
        <Field label="Password" error={errors.password?.message}>
          <Input type="password" autoComplete="current-password" {...form.register('password')} />
        </Field>
        {error ? (
          <p role="alert" className="rounded-medium bg-sulfur px-5 py-3 text-body-sm">
            {error}
          </p>
        ) : null}
        <div className="flex flex-wrap items-center gap-2 pt-2">
          <Button type="submit" loading={isSubmitting}>
            Sign in
          </Button>
          <Link href="/forgot-password" className={buttonClass('ghost', 'md')}>
            Forgot password
          </Link>
        </div>
      </form>

      {google ? (
        <>
          <Divider />
          <Button
            variant="secondary"
            onClick={() =>
              authClient.signIn.social({ provider: 'google', callbackURL: destination })
            }
          >
            Continue with Google
          </Button>
        </>
      ) : null}

      <Divider />
      <p className="text-body-sm">
        New to DatoFlow?{' '}
        <Link href={`/sign-up${query}`} className="underline decoration-dotted underline-offset-4">
          Create an account
        </Link>
      </p>
    </div>
  );
}
