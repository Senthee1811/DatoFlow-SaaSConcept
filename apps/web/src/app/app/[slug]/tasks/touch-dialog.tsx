'use client';

import { TOUCH_LABEL } from '@datoflow/domain';
import {
  TOUCH_CHANNELS,
  type LeadDto,
  type TaskDto,
  type TouchChannelCode,
  type TouchResultDto,
} from '@datoflow/shared';
import { Button, Field, Input, Modal, Select, Textarea } from '@datoflow/ui';
import { useState, type FormEvent } from 'react';
import { toast } from 'sonner';
import { api, ApiProblem, problemMessage } from '@/lib/api';
import type { Lookups } from '@/lib/lookups';
import {
  blankNextStep,
  NextStepFields,
  nextStepBody,
  type NextStepValues,
} from './next-step-fields';

type Outcome = 'next' | 'won' | 'lost' | 'none';

/**
 * Log a touch (UF-8). On an open lead the touch saves only with a next step, or with a move to
 * Won or Lost (TASK-02). Closing the panel without saving discards the touch.
 */
export function TouchDialog({
  open,
  onClose,
  onSaved,
  lead,
  openTasks,
  lookups,
  orgId,
  userId,
  timezone,
  canAssign,
  warnOnly,
  wonRequiresDealValue,
}: {
  open: boolean;
  onClose: () => void;
  onSaved: () => void;
  lead: LeadDto;
  openTasks: TaskDto[];
  lookups: Lookups;
  orgId: string;
  userId: string;
  timezone: string;
  canAssign: boolean;
  warnOnly: boolean;
  wonRequiresDealValue: boolean;
}) {
  return (
    <Modal open={open} title="Log a touch" onClose={onClose}>
      {open ? (
        <TouchForm
          {...{
            lead,
            openTasks,
            lookups,
            orgId,
            userId,
            timezone,
            canAssign,
            warnOnly,
            wonRequiresDealValue,
          }}
          onCancel={onClose}
          onSaved={onSaved}
        />
      ) : null}
    </Modal>
  );
}

function TouchForm({
  lead,
  openTasks,
  lookups,
  orgId,
  userId,
  timezone,
  canAssign,
  warnOnly,
  wonRequiresDealValue,
  onCancel,
  onSaved,
}: {
  lead: LeadDto;
  openTasks: TaskDto[];
  lookups: Lookups;
  orgId: string;
  userId: string;
  timezone: string;
  canAssign: boolean;
  warnOnly: boolean;
  wonRequiresDealValue: boolean;
  onCancel: () => void;
  onSaved: () => void;
}) {
  const [channel, setChannel] = useState<TouchChannelCode>('CALL');
  const [text, setText] = useState('');
  // The touch usually takes care of what was overdue or due.
  const [complete, setComplete] = useState<Set<string>>(
    () => new Set(openTasks.filter((t) => t.canEdit && t.overdue).map((t) => t.id)),
  );
  const [outcome, setOutcome] = useState<Outcome>('next');
  const [step, setStep] = useState<NextStepValues>(() => blankNextStep(timezone, userId));
  const [lossReasonId, setLossReasonId] = useState('');
  const [dealValue, setDealValue] = useState(lead.dealValue ? String(lead.dealValue) : '');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const won = lookups.stages.find((s) => s.kind === 'WON')!;
  const lost = lookups.stages.find((s) => s.kind === 'LOST')!;
  const needsValue = wonRequiresDealValue;

  async function submit(event: FormEvent) {
    event.preventDefault();
    setSaving(true);
    setErrors({});
    try {
      const result = await api<TouchResultDto>(`/v1/orgs/${orgId}/leads/${lead.id}/activities`, {
        method: 'POST',
        body: {
          type: 'TOUCH',
          channel,
          ...(text.trim() ? { text: text.trim() } : {}),
          ...(complete.size ? { completeTaskIds: [...complete] } : {}),
          ...(outcome === 'next' ? { nextStep: nextStepBody(step, timezone) } : {}),
          ...(outcome === 'won'
            ? {
                close: {
                  stageId: won.id,
                  ...(dealValue.trim() ? { dealValue: Number(dealValue) } : {}),
                },
              }
            : {}),
          ...(outcome === 'lost' ? { close: { stageId: lost.id, lossReasonId } } : {}),
        },
      });
      toast(
        result.warning
          ? `${TOUCH_LABEL[channel]} logged without a next step`
          : outcome === 'next'
            ? `${TOUCH_LABEL[channel]} logged. Next step set`
            : `${TOUCH_LABEL[channel]} logged. Lead marked ${outcome === 'won' ? 'won' : 'lost'}`,
      );
      onSaved();
    } catch (e) {
      if (e instanceof ApiProblem && e.status === 422) setErrors(e.fieldErrors);
      toast(problemMessage(e));
    } finally {
      setSaving(false);
    }
  }

  const outcomes: { value: Outcome; label: string }[] = [
    { value: 'next', label: 'Set the next step' },
    { value: 'won', label: 'Mark as won' },
    { value: 'lost', label: 'Mark as lost' },
    ...(warnOnly ? [{ value: 'none' as const, label: 'No next step' }] : []),
  ];

  return (
    <form onSubmit={submit} className="flex flex-col gap-4">
      <p>
        With <strong className="font-medium">{lead.name}</strong>
        {lead.company ? `, ${lead.company}` : ''}
      </p>
      <Field label="What did you do">
        <Select value={channel} onChange={(e) => setChannel(e.target.value as TouchChannelCode)}>
          {TOUCH_CHANNELS.map((c) => (
            <option key={c} value={c}>
              {TOUCH_LABEL[c]}
            </option>
          ))}
        </Select>
      </Field>
      <Field label="What happened" hint="Optional">
        <Textarea
          rows={3}
          maxLength={5000}
          value={text}
          onChange={(e) => setText(e.target.value)}
        />
      </Field>

      {openTasks.some((t) => t.canEdit) ? (
        <fieldset className="flex flex-col gap-2">
          <legend className="mb-2 px-5 text-body-sm">Done with this touch</legend>
          {openTasks
            .filter((t) => t.canEdit)
            .map((t) => (
              <label
                key={t.id}
                className="flex min-h-11 cursor-pointer items-center gap-3 rounded-medium bg-pumice px-5 py-2"
              >
                <input
                  type="checkbox"
                  className="size-5 accent-obsidian"
                  checked={complete.has(t.id)}
                  onChange={(e) => {
                    const next = new Set(complete);
                    if (e.target.checked) next.add(t.id);
                    else next.delete(t.id);
                    setComplete(next);
                  }}
                />
                <span className="text-body-sm">{t.title}</span>
              </label>
            ))}
        </fieldset>
      ) : null}

      <fieldset className="flex flex-col gap-2">
        <legend className="mb-2 px-5 text-body-sm">Then</legend>
        <div className="flex flex-wrap gap-2">
          {outcomes.map((o) => (
            <label
              key={o.value}
              className="flex min-h-11 cursor-pointer items-center gap-2 rounded-pills bg-pumice px-4 has-[:checked]:bg-obsidian has-[:checked]:text-chalk"
            >
              <input
                type="radio"
                name="outcome"
                value={o.value}
                className="size-4 accent-ember"
                checked={outcome === o.value}
                onChange={() => setOutcome(o.value)}
              />
              <span className="text-body-sm">{o.label}</span>
            </label>
          ))}
        </div>
      </fieldset>

      {outcome === 'next' ? (
        <NextStepFields
          values={step}
          onChange={setStep}
          assignees={lookups.assignees}
          canAssign={canAssign}
          timezone={timezone}
          errors={errors}
          prefix="nextStep."
        />
      ) : null}
      {outcome === 'won' ? (
        <Field
          label={`Deal value (${lead.currency})`}
          hint={needsValue ? undefined : 'Optional in this workspace'}
          error={errors['close.dealValue'] ?? errors.dealValue}
        >
          <Input
            type="number"
            inputMode="decimal"
            min={needsValue ? 1 : 0}
            step="0.01"
            required={needsValue}
            value={dealValue}
            onChange={(e) => setDealValue(e.target.value)}
          />
        </Field>
      ) : null}
      {outcome === 'lost' ? (
        <Field label="Loss reason" error={errors['close.lossReasonId'] ?? errors.lossReasonId}>
          <Select required value={lossReasonId} onChange={(e) => setLossReasonId(e.target.value)}>
            <option value="" disabled>
              Choose a reason
            </option>
            {lookups.lossReasons.map((r) => (
              <option key={r.id} value={r.id}>
                {r.label}
              </option>
            ))}
          </Select>
        </Field>
      ) : null}
      {outcome === 'none' ? (
        <p className="rounded-medium bg-sulfur px-5 py-3 text-body-sm">
          This workspace only warns. The lead will have no next step, and the radar will flag it
          once its stage SLA runs out.
        </p>
      ) : null}

      <div className="flex flex-wrap gap-2 pt-2">
        <Button type="submit" loading={saving}>
          Save touch
        </Button>
        <Button type="button" variant="ghost" onClick={onCancel}>
          Discard
        </Button>
      </div>
    </form>
  );
}
