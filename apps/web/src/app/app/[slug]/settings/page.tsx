'use client';

import type { OrgDto } from '@datoflow/shared';
import { Button, Card, Field, Input, Select } from '@datoflow/ui';
import { useState, type FormEvent } from 'react';
import { toast } from 'sonner';
import { api, problemMessage } from '@/lib/api';
import { CURRENCIES, TIMEZONES } from '@/lib/options';
import { useOrg } from '@/lib/org-context';
import { PageHeader } from '../page-header';

export default function SettingsPage() {
  const { org, reload } = useOrg();
  const [name, setName] = useState(org.name);
  const [timezone, setTimezone] = useState(org.timezone);
  const [currency, setCurrency] = useState(org.currency);
  const [repsSeeAll, setRepsSeeAll] = useState(Boolean(org.settings.repsCanSeeAllLeads));
  const [saving, setSaving] = useState(false);

  async function save(event: FormEvent) {
    event.preventDefault();
    setSaving(true);
    try {
      await api<OrgDto>(`/v1/orgs/${org.id}`, {
        method: 'PATCH',
        body: { name, timezone, currency, settings: { repsCanSeeAllLeads: repsSeeAll } },
      });
      await reload();
      toast('Settings saved');
    } catch (e) {
      toast(problemMessage(e));
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
      <PageHeader title="Settings" description="Workspace details and who sees which leads" />
      <Card>
        <form onSubmit={save} className="flex max-w-2xl flex-col gap-4">
          <Field label="Workspace name">
            <Input
              required
              minLength={2}
              maxLength={80}
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </Field>
          <div className="grid gap-4 sm:grid-cols-[2fr_1fr]">
            <Field label="Timezone" hint="Dates, reminders and the daily digest use it">
              <Select value={timezone} onChange={(e) => setTimezone(e.target.value)}>
                {TIMEZONES.map((z) => (
                  <option key={z} value={z}>
                    {z.replaceAll('_', ' ')}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Currency">
              <Select value={currency} onChange={(e) => setCurrency(e.target.value)}>
                {CURRENCIES.map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </Select>
            </Field>
          </div>
          <label className="flex min-h-11 cursor-pointer items-start gap-3 rounded-medium bg-pumice px-5 py-4">
            <input
              type="checkbox"
              className="mt-1 size-5 accent-obsidian"
              checked={repsSeeAll}
              onChange={(e) => setRepsSeeAll(e.target.checked)}
            />
            <span>
              Reps can see all leads
              <span className="block text-body-sm text-obsidian/75">
                Off by default. When off, a Sales Rep sees leads assigned to them and the unassigned
                pool
              </span>
            </span>
          </label>
          <div className="pt-2">
            <Button type="submit" loading={saving}>
              Save settings
            </Button>
          </div>
        </form>
      </Card>
    </>
  );
}
