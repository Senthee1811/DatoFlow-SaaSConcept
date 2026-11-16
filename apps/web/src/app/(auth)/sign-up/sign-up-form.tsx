'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import { Button, Divider, Field, Input } from '@datoflow/ui';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { authClient } from '@/lib/auth-client';
import { safeNext } from '@/lib/redirect';

const schema = z.object({
  name: z.string().trim().min(2, 'Enter your name').max(80),
  email: z.email('Enter an email address'),
  password: z.string().min(10, 'Use at least 10 characters').max(128),
});
type Values = z.infer<typeof schema>;

export function SignUpForm({
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
    defaultValues: { name: '', email: defaultEmail ?? '', password: '' },
  });

  async function onSubmit(values: Values) {
    setError(null);
    const { error: authError } = await authClient.signUp.email({
      ...values,
      callbackURL: destination,
    });
    if (authError) {
      if (authError.status === 422 || /exist/i.test(authError.message ?? '')) {
        setError('An account with this email already exists. Sign in instead');
      } else if (authError.status === 429)
        setError('Too many attempts. Wait a minute and try again');
      else setError(authError.message ?? 'Something went wrong. Try again');
      return;
    }
    router.push(`/check-email?email=${encodeURIComponent(values.email)}`);
  }

  const { errors, isSubmitting } = form.formState;

  return (
    <div className="flex flex-col gap-6">
      <form noValidate onSubmit={form.handleSubmit(onSubmit)} className="flex flex-col gap-4">
        <Field label="Your name" error={errors.name?.message}>
          <Input autoComplete="name" {...form.register('name')} />
        </Field>
        <Field label="Work email" error={errors.email?.message}>
          <Input type="email" autoComplete="email" {...form.register('email')} />
        </Field>
        <Field label="Password" hint="At least 10 characters" error={errors.password?.message}>
          <Input type="password" autoComplete="new-password" {...form.register('password')} />
        </Field>
        {error ? (
          <p role="alert" className="rounded-medium bg-sulfur px-5 py-3 text-body-sm">
            {error}
          </p>
        ) : null}
        <div className="pt-2">
          <Button type="submit" loading={isSubmitting}>
            Create account
          </Button>
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
        Already have an account?{' '}
        <Link
          href={`/sign-in${next ? `?next=${encodeURIComponent(destination)}` : ''}`}
          className="underline decoration-dotted underline-offset-4"
        >
          Sign in
        </Link>
      </p>
    </div>
  );
}
