'use client';

import { PRIORITY_LABEL, SOURCE_LABEL } from '@datoflow/domain';
import { LEAD_SOURCES, PRIORITIES, type LeadDto } from '@datoflow/shared';
import { Button, Field, Input, Select, Textarea } from '@datoflow/ui';
import { useState, type FormEvent } from 'react';
import { ApiProblem, problemMessage } from '@/lib/api';
import type { Lookups } from '@/lib/lookups';

export interface LeadFormValues {
  name: string;
  company: string;
  email: string;
  phone: string;
  source: string;
  priority: string;
  dealValue: string;
  notes: string;
  stageId?: string;
  ownerId?: string;
}

export function initialValues(lead?: LeadDto): LeadFormValues {
  return {
    name: lead?.name ?? '',
    company: lead?.company ?? '',
    email: lead?.email ?? '',
    phone: lead?.phone ?? '',
    source: lead?.source ?? 'MANUAL',
    priority: lead?.priority ?? 'NORMAL',
    dealValue: lead?.dealValue != null ? String(lead.dealValue) : '',
    notes: lead?.notes ?? '',
  };
}

/** The request body for the fields shown. Empty optional fields are sent as null. */
export function toBody(values: LeadFormValues) {
  const text = (v: string) => (v.trim() === '' ? null : v.trim());
  return {
    name: values.name.trim(),
    company: text(values.company),
    email: text(values.email),
    phone: text(values.phone),
    source: values.source,
    priority: values.priority,
    dealValue: values.dealValue.trim() === '' ? null : Number(values.dealValue),
    notes: text(values.notes),
    ...(values.stageId ? { stageId: values.stageId } : {}),
    ...(values.ownerId !== undefined
      ? { ownerId: values.ownerId === '' ? null : values.ownerId }
      : {}),
  };
}

export function LeadForm({
  initial,
  lookups,
  currency,
  disabled,
  withPlacement,
  submitLabel,
  onSubmit,
}: {
  initial: LeadFormValues;
  lookups: Lookups;
  currency: string;
  disabled?: boolean;
  withPlacement?: { canAssign: boolean; defaultOwnerId: string };
  submitLabel: string;
  onSubmit: (values: LeadFormValues) => Promise<void>;
}) {
  const [values, setValues] = useState<LeadFormValues>(
    withPlacement
      ? {
          ...initial,
          stageId: lookups.stages.find((s) => s.kind === 'OPEN')?.id,
          ownerId: withPlacement.defaultOwnerId,
        }
      : initial,
  );
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const set = (key: keyof LeadFormValues) => (e: { target: { value: string } }) =>
    setValues((v) => ({ ...v, [key]: e.target.value }));

  async function submit(event: FormEvent) {
    event.preventDefault();
    setSaving(true);
    setErrors({});
    setFormError(null);
    try {
      await onSubmit(values);
    } catch (e) {
      if (e instanceof ApiProblem && Object.keys(e.fieldErrors).length) setErrors(e.fieldErrors);
      else setFormError(problemMessage(e));
    } finally {
      setSaving(false);
    }
  }

  return (
    <form onSubmit={submit} noValidate className="flex flex-col gap-4">
      <fieldset disabled={disabled || saving} className="grid gap-4 sm:grid-cols-2">
        <legend className="sr-only">Lead details</legend>
        <Field label="Name" error={errors.name}>
          <Input required autoComplete="off" value={values.name} onChange={set('name')} />
        </Field>
        <Field label="Company" error={errors.company}>
          <Input autoComplete="off" value={values.company} onChange={set('company')} />
        </Field>
        <Field label="Email" error={errors.email}>
          <Input type="email" autoComplete="off" value={values.email} onChange={set('email')} />
        </Field>
        <Field label="Phone" hint="Local numbers use the workspace country" error={errors.phone}>
          <Input type="tel" autoComplete="off" value={values.phone} onChange={set('phone')} />
        </Field>
        <Field label="Source" error={errors.source}>
          <Select value={values.source} onChange={set('source')}>
            {LEAD_SOURCES.map((s) => (
              <option key={s} value={s}>
                {SOURCE_LABEL[s]}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Priority" error={errors.priority}>
          <Select value={values.priority} onChange={set('priority')}>
            {PRIORITIES.map((p) => (
              <option key={p} value={p}>
                {PRIORITY_LABEL[p]}
              </option>
            ))}
          </Select>
        </Field>
        <Field label={`Deal value (${currency})`} error={errors.dealValue}>
          <Input
            type="number"
            inputMode="decimal"
            min={0}
            step="0.01"
            value={values.dealValue}
            onChange={set('dealValue')}
          />
        </Field>
        {withPlacement ? (
          <>
            <Field label="Stage" error={errors.stageId}>
              <Select value={values.stageId} onChange={set('stageId')}>
                {lookups.stages
                  .filter((s) => s.kind === 'OPEN')
                  .map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name}
                    </option>
                  ))}
              </Select>
            </Field>
            <Field label="Owner" error={errors.ownerId}>
              <Select value={values.ownerId} onChange={set('ownerId')}>
                <option value="">Unassigned</option>
                {lookups.assignees
                  .filter(
                    (a) => withPlacement.canAssign || a.userId === withPlacement.defaultOwnerId,
                  )
                  .map((a) => (
                    <option key={a.userId} value={a.userId}>
                      {a.name}
                    </option>
                  ))}
              </Select>
            </Field>
          </>
        ) : null}
        <Field label="Notes" error={errors.notes} className="sm:col-span-2">
          <Textarea rows={4} value={values.notes} onChange={set('notes')} />
        </Field>
      </fieldset>
      {formError ? (
        <p role="alert" className="rounded-medium bg-sulfur px-5 py-3 text-body-sm">
          {formError}
        </p>
      ) : null}
      {disabled ? null : (
        <div>
          <Button type="submit" loading={saving}>
            {submitLabel}
          </Button>
        </div>
      )}
    </form>
  );
}
