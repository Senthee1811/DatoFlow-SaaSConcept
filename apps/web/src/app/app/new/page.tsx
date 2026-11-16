'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import { createOrgSchema, type OrgDto } from '@datoflow/shared';
import { Button, Card, Field, Input, Logo, Select } from '@datoflow/ui';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import type { z } from 'zod';
import { api, ApiProblem, problemMessage } from '@/lib/api';
import { authClient } from '@/lib/auth-client';
import { CURRENCIES, DEFAULT_CURRENCY, DEFAULT_TIMEZONE, TIMEZONES, slugify } from '@/lib/options';

type Values = z.input<typeof createOrgSchema>;
const FIELDS = ['name', 'slug', 'timezone', 'currency'] as const;

export default function NewOrgPage() {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [slugTouched, setSlugTouched] = useState(false);
  const form = useForm<Values, unknown, z.output<typeof createOrgSchema>>({
    resolver: zodResolver(createOrgSchema),
    defaultValues: { name: '', slug: '', timezone: DEFAULT_TIMEZONE, currency: DEFAULT_CURRENCY },
  });
  const { errors, isSubmitting } = form.formState;
  const name = form.register('name');

  async function onSubmit(values: z.output<typeof createOrgSchema>) {
    setError(null);
    try {
      const org = await api<OrgDto>('/v1/orgs', { method: 'POST', body: values });
      await authClient.organization.setActive({ organizationId: org.id });
      router.replace(`/app/${org.slug}`);
    } catch (e) {
      if (e instanceof ApiProblem) {
        const fields = e.fieldErrors;
        let placed = false;
        for (const f of FIELDS) {
          if (fields[f]) {
            form.setError(f, { message: fields[f] });
            placed = true;
          }
        }
        if (!placed) setError(e.message);
      } else setError(problemMessage(e));
    }
  }

  return (
    <main className="mx-auto flex min-h-dvh max-w-page flex-col p-4 lg:p-6">
      <header className="py-4 pl-2">
        <Logo />
      </header>
      <div className="flex flex-1 items-center justify-center py-8">
        <Card className="w-full max-w-2xl">
          <h1 className="display mb-3 text-heading-lg">Set up your workspace</h1>
          <p className="mb-8 text-obsidian/80">
            You become its Owner. You can invite your team next.
          </p>
          <form noValidate onSubmit={form.handleSubmit(onSubmit)} className="flex flex-col gap-4">
            <Field label="Agency or team name" error={errors.name?.message}>
              <Input
                autoComplete="organization"
                {...name}
                onChange={(e) => {
                  void name.onChange(e);
                  if (!slugTouched) form.setValue('slug', slugify(e.target.value));
                }}
              />
            </Field>
            <Field
              label="Workspace address"
              hint="Lowercase letters, numbers and hyphens"
              error={errors.slug?.message}
            >
              <Input
                autoCapitalize="none"
                spellCheck={false}
                {...form.register('slug', { onChange: () => setSlugTouched(true) })}
              />
            </Field>
            <div className="grid gap-4 sm:grid-cols-[2fr_1fr]">
              <Field
                label="Timezone"
                hint="Dates and reminders use it"
                error={errors.timezone?.message}
              >
                <Select {...form.register('timezone')}>
                  {TIMEZONES.map((z) => (
                    <option key={z} value={z}>
                      {z.replaceAll('_', ' ')}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="Currency" error={errors.currency?.message}>
                <Select {...form.register('currency')}>
                  {CURRENCIES.map((c) => (
                    <option key={c} value={c}>
                      {c}
                    </option>
                  ))}
                </Select>
              </Field>
            </div>
            {error ? (
              <p role="alert" className="rounded-medium bg-sulfur px-5 py-3 text-body-sm">
                {error}
              </p>
            ) : null}
            <div className="pt-2">
              <Button type="submit" loading={isSubmitting}>
                Create workspace
              </Button>
            </div>
          </form>
        </Card>
      </div>
    </main>
  );
}
