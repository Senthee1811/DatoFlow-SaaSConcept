'use client';

import { TASK_TYPE_LABEL, utcToZonedInput, zonedDateTimeToUtc } from '@datoflow/domain';
import { TASK_TYPES, type AssigneeDto, type TaskTypeCode } from '@datoflow/shared';
import { Field, Input, Select } from '@datoflow/ui';

export interface NextStepValues {
  title: string;
  type: TaskTypeCode;
  /** `YYYY-MM-DDTHH:mm` in the organization's timezone. */
  due: string;
  assigneeId: string;
}

/** A fresh next step: tomorrow at 10:00 in the organization's timezone, for the caller. */
export function blankNextStep(timezone: string, userId: string): NextStepValues {
  const tomorrow = utcToZonedInput(new Date(Date.now() + 86_400_000), timezone).slice(0, 10);
  return { title: '', type: 'CALL', due: `${tomorrow}T10:00`, assigneeId: userId };
}

/** The API body for a next step. The due time is read in the organization's timezone. */
export function nextStepBody(values: NextStepValues, timezone: string) {
  return {
    title: values.title.trim(),
    type: values.type,
    dueAt: zonedDateTimeToUtc(values.due, timezone).toISOString(),
    assigneeId: values.assigneeId,
  };
}

/** Title, type, due time and assignee of a next step (TASK-01). */
export function NextStepFields({
  values,
  onChange,
  assignees,
  canAssign,
  timezone,
  errors = {},
  prefix = '',
}: {
  values: NextStepValues;
  onChange: (values: NextStepValues) => void;
  assignees: AssigneeDto[];
  canAssign: boolean;
  timezone: string;
  errors?: Record<string, string>;
  /** Field-error key prefix, such as `nextStep.` inside a touch. */
  prefix?: string;
}) {
  const set = (patch: Partial<NextStepValues>) => onChange({ ...values, ...patch });
  return (
    <div className="flex flex-col gap-4">
      <Field
        label="Next step"
        error={errors[`${prefix}title`] ?? errors[prefix.replace(/\.$/, '')]}
      >
        <Input
          required
          maxLength={200}
          placeholder="Call to confirm the budget"
          value={values.title}
          onChange={(e) => set({ title: e.target.value })}
        />
      </Field>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Type">
          <Select
            value={values.type}
            onChange={(e) => set({ type: e.target.value as TaskTypeCode })}
          >
            {TASK_TYPES.map((t) => (
              <option key={t} value={t}>
                {TASK_TYPE_LABEL[t]}
              </option>
            ))}
          </Select>
        </Field>
        <Field
          label="Due"
          hint={`${timezone.replaceAll('_', ' ')} time`}
          error={errors[`${prefix}dueAt`]}
        >
          <Input
            type="datetime-local"
            required
            value={values.due}
            onChange={(e) => set({ due: e.target.value })}
          />
        </Field>
      </div>
      <Field
        label="Who does it"
        hint={canAssign ? undefined : 'Sales Reps set next steps for themselves'}
        error={errors[`${prefix}assigneeId`]}
      >
        <Select
          value={values.assigneeId}
          disabled={!canAssign}
          onChange={(e) => set({ assigneeId: e.target.value })}
        >
          {assignees.map((a) => (
            <option key={a.userId} value={a.userId}>
              {a.name}
            </option>
          ))}
        </Select>
      </Field>
    </div>
  );
}
