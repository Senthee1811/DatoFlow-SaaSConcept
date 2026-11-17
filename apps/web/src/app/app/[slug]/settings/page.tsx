'use client';

import type { OrgDto } from '@datoflow/shared';
import { Button, Card, Field, Input, Select } from '@datoflow/ui';
import { useState, type FormEvent } from 'react';
import { toast } from 'sonner';
import { api, problemMessage } from '@/lib/api';
import { COUNTRIES, CURRENCIES, TIMEZONES } from '@/lib/options';
import { useOrg } from '@/lib/org-context';
import { PageHeader } from '../page-header';
import { LossReasonsEditor, PipelineEditor } from './pipeline-editor';

export default function SettingsPage() {
  const { org, reload } = useOrg();
  const [name, setName] = useState(org.name);
  const [timezone, setTimezone] = useState(org.timezone);
  const [currency, setCurrency] = useState(org.currency);
  const [country, setCountry] = useState(org.country);
  const [repsSeeAll, setRepsSeeAll] = useState(Boolean(org.settings.repsCanSeeAllLeads));
  const [wonNeedsValue, setWonNeedsValue] = useState(org.settings.wonRequiresDealValue ?? true);
  const [warnOnly, setWarnOnly] = useState(org.settings.nextStepRule === 'warn');
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);

  async function save(event: FormEvent) {
    event.preventDefault();
    setSaving(true);
    try {
      await api<OrgDto>(`/v1/orgs/${org.id}`, {
        method: 'PATCH',
        body: {
          name,
          timezone,
          currency,
          country,
          settings: {
            repsCanSeeAllLeads: repsSeeAll,
            wonRequiresDealValue: wonNeedsValue,
            nextStepRule: warnOnly ? 'warn' : 'require',
          },
        },
      });
      await reload();
      toast('Settings saved');
    } catch (e) {
      toast(problemMessage(e));
    } finally {
      setSaving(false);
    }
  }

  async function deleteSample() {
    if (
      !window.confirm('Delete the sample agency? Its 60 leads and 3 reps go. Your own leads stay.')
    )
      return;
    setDeleting(true);
    try {
      const removed = await api<{ leads: number; reps: number }>(`/v1/orgs/${org.id}/sample-data`, {
        method: 'DELETE',
      });
      await reload();
      toast(`Sample data deleted: ${removed.leads} leads and ${removed.reps} reps`);
    } catch (e) {
      toast(problemMessage(e));
    } finally {
      setDeleting(false);
    }
  }

  return (
    <>
      <PageHeader
        title="Settings"
        description="Workspace details, stages and who sees which leads"
      />
      <Card>
        <h2 className="display mb-6 text-heading">Workspace</h2>
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
          <Field
            label="Country"
            hint="Phone numbers without a country code are read as this country"
          >
            <Select value={country} onChange={(e) => setCountry(e.target.value)}>
              {COUNTRIES.map((c) => (
                <option key={c.code} value={c.code}>
                  {c.name}
                </option>
              ))}
            </Select>
          </Field>
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
          <label className="flex min-h-11 cursor-pointer items-start gap-3 rounded-medium bg-pumice px-5 py-4">
            <input
              type="checkbox"
              className="mt-1 size-5 accent-obsidian"
              checked={wonNeedsValue}
              onChange={(e) => setWonNeedsValue(e.target.checked)}
            />
            <span>
              Won leads need a deal value
              <span className="block text-body-sm text-obsidian/75">
                Lost leads always need a loss reason
              </span>
            </span>
          </label>
          <label className="flex min-h-11 cursor-pointer items-start gap-3 rounded-medium bg-pumice px-5 py-4">
            <input
              type="checkbox"
              className="mt-1 size-5 accent-obsidian"
              checked={warnOnly}
              onChange={(e) => setWarnOnly(e.target.checked)}
            />
            <span>
              Only warn when a touch has no next step
              <span className="block text-body-sm text-obsidian/75">
                Off by default. When off, a call, email, message or meeting on an open lead saves
                only with a dated next step, or with a move to Won or Lost
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

      <PipelineEditor orgId={org.id} />
      <LossReasonsEditor orgId={org.id} />

      {org.hasSampleData ? (
        <Card>
          <h2 className="display mb-2 text-heading">Sample data</h2>
          <p className="mb-6 max-w-2xl text-obsidian/80">
            The sample agency shows how DatoFlow works. Deleting it removes only sample leads and
            sample reps. Your own leads stay, and any you gave to a sample rep return to the
            unassigned pool.
          </p>
          <Button variant="secondary" loading={deleting} onClick={deleteSample}>
            Delete sample data
          </Button>
        </Card>
      ) : null}
    </>
  );
}
