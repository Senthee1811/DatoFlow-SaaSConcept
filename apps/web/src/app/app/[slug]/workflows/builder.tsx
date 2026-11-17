'use client';

import { PRIORITY_LABEL, SOURCE_LABEL, TASK_TYPE_LABEL } from '@datoflow/domain';
import { LEAD_SOURCES } from '@datoflow/shared';
import { Button, Card, Field, Input, Select, Textarea } from '@datoflow/ui';
import {
  ACTION_LABEL,
  ACTION_TYPES,
  CONDITION_FIELD_LABEL,
  CONDITION_FIELDS,
  CONDITION_OPERATOR_LABEL,
  CONDITION_OPERATORS,
  MAX_ACTIONS,
  MAX_CONDITIONS,
  PRIORITIES,
  TASK_KINDS,
  TRIGGER_LABEL,
  TRIGGERS,
  UNASSIGNED,
  type Action,
  type ActionType,
  type Condition,
  type ConditionField,
  type Definition,
  type Trigger,
} from '@datoflow/workflow';
import { ArrowDown, ArrowUp, Plus, Trash2 } from 'lucide-react';
import { useId, useState, type ReactNode } from 'react';
import type { Lookups } from '@/lib/lookups';

export type FieldErrors = { path: string; message: string }[];

/** Errors under `prefix`, such as `body.definition.actions.2`. */
function errorsAt(errors: FieldErrors, prefix: string) {
  return errors.filter((e) => e.path === prefix || e.path.startsWith(`${prefix}.`));
}

function newAction(type: ActionType): Action {
  switch (type) {
    case 'assign':
      return { type, mode: 'user', userIds: [] };
    case 'create_task':
      return {
        type,
        title: 'Call the new lead',
        taskType: 'CALL',
        dueInHours: 4,
        priority: 'NORMAL',
        assigneeId: null,
      };
    case 'send_email':
      return {
        type,
        to: 'lead',
        subject: 'Thanks for getting in touch',
        body: 'Hi {{lead.name}},\n\nThanks for your enquiry. {{owner.name}} will call you shortly.\n\n{{org.name}}',
        delayMinutes: 0,
      };
    case 'notify':
      return { type, to: 'owner', userId: null, message: 'New lead: {{lead.name}}' };
    case 'update_field':
      return { type, field: 'priority', value: 'HIGH' };
  }
}

function defaultValues(field: ConditionField, lookups: Lookups): string[] {
  if (field === 'source') return ['WEBSITE'];
  if (field === 'priority') return ['HIGH'];
  if (field === 'stage') return lookups.stages[0] ? [lookups.stages[0].id] : [];
  return [UNASSIGNED];
}

function options(field: ConditionField, lookups: Lookups): { value: string; label: string }[] {
  switch (field) {
    case 'source':
      return LEAD_SOURCES.map((s) => ({ value: s, label: SOURCE_LABEL[s] }));
    case 'priority':
      return PRIORITIES.map((p) => ({ value: p, label: PRIORITY_LABEL[p] }));
    case 'stage':
      return lookups.stages.map((s) => ({ value: s.id, label: s.name }));
    case 'assignee':
      return [
        { value: UNASSIGNED, label: 'Unassigned' },
        ...lookups.assignees.map((a) => ({ value: a.userId, label: a.name })),
      ];
  }
}

/** A list of checkboxes that edits a set of string values. */
function Checks({
  legend,
  items,
  value,
  onChange,
  error,
}: {
  legend: string;
  items: { value: string; label: string }[];
  value: string[];
  onChange: (next: string[]) => void;
  error?: string;
}) {
  return (
    <fieldset className="flex flex-col gap-2">
      <legend className="px-5 pb-2 text-body-sm">{legend}</legend>
      <div className="flex flex-wrap gap-2">
        {items.map((item) => {
          const checked = value.includes(item.value);
          return (
            <label
              key={item.value}
              className="inline-flex min-h-11 cursor-pointer items-center gap-2 rounded-pills border-[1.5px] border-obsidian px-4 text-body-sm has-[:checked]:bg-obsidian has-[:checked]:text-chalk has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-obsidian"
            >
              <input
                type="checkbox"
                className="sr-only"
                checked={checked}
                onChange={() =>
                  onChange(checked ? value.filter((v) => v !== item.value) : [...value, item.value])
                }
              />
              {item.label}
            </label>
          );
        })}
      </div>
      {error ? (
        <p role="alert" className="px-5 text-body-sm">
          {error}
        </p>
      ) : null}
    </fieldset>
  );
}

function MemberSelect({
  label,
  value,
  onChange,
  lookups,
  empty,
  error,
}: {
  label: string;
  value: string | null;
  onChange: (v: string | null) => void;
  lookups: Lookups;
  /** The label of the "nobody chosen" choice, such as "The lead owner". Omit to require one. */
  empty?: string;
  error?: string;
}) {
  return (
    <Field label={label} {...(error ? { error } : {})}>
      <Select value={value ?? ''} onChange={(e) => onChange(e.target.value || null)}>
        {empty ? <option value="">{empty}</option> : <option value="">Choose a member</option>}
        {lookups.assignees.map((a) => (
          <option key={a.userId} value={a.userId}>
            {a.name}
            {a.isSample ? ' (sample)' : ''}
          </option>
        ))}
      </Select>
    </Field>
  );
}

const DELAY_UNITS = [
  { value: 1, label: 'minutes' },
  { value: 60, label: 'hours' },
  { value: 1440, label: 'days' },
] as const;

function unitFor(minutes: number) {
  if (minutes > 0 && minutes % 1440 === 0) return 1440;
  if (minutes > 0 && minutes % 60 === 0) return 60;
  return 1;
}

function first(errors: FieldErrors, prefix: string) {
  return errorsAt(errors, prefix)[0]?.message;
}

const TEMPLATE_HINT =
  'You can use {{lead.name}}, {{lead.company}}, {{owner.name}} and {{org.name}}';

function ActionFields({
  action,
  onChange,
  lookups,
  errors,
  path,
}: {
  action: Action;
  onChange: (a: Action) => void;
  lookups: Lookups;
  errors: FieldErrors;
  path: string;
}) {
  const err = (sub: string) => {
    const message = first(errors, `${path}.${sub}`);
    return message ? { error: message } : {};
  };
  switch (action.type) {
    case 'assign':
      return (
        <div className="grid gap-4">
          <Field label="Assign to">
            <Select
              value={action.mode}
              onChange={(e) =>
                onChange({
                  ...action,
                  mode: e.target.value as 'user' | 'round_robin',
                  userIds: e.target.value === 'user' ? action.userIds.slice(0, 1) : action.userIds,
                })
              }
            >
              <option value="user">One member</option>
              <option value="round_robin">Members in turn (round-robin)</option>
            </Select>
          </Field>
          {action.mode === 'user' ? (
            <MemberSelect
              label="Member"
              value={action.userIds[0] ?? null}
              onChange={(v) => onChange({ ...action, userIds: v ? [v] : [] })}
              lookups={lookups}
              {...err('userIds')}
            />
          ) : (
            <Checks
              legend="Members, in this order"
              items={lookups.assignees.map((a) => ({ value: a.userId, label: a.name }))}
              value={action.userIds}
              onChange={(userIds) => onChange({ ...action, userIds })}
              {...err('userIds')}
            />
          )}
        </div>
      );
    case 'create_task':
      return (
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Task" className="sm:col-span-2" {...err('title')}>
            <Input
              value={action.title}
              maxLength={200}
              onChange={(e) => onChange({ ...action, title: e.target.value })}
            />
          </Field>
          <Field label="Type">
            <Select
              value={action.taskType}
              onChange={(e) =>
                onChange({ ...action, taskType: e.target.value as (typeof TASK_KINDS)[number] })
              }
            >
              {TASK_KINDS.map((k) => (
                <option key={k} value={k}>
                  {TASK_TYPE_LABEL[k]}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Due after (hours)" hint="Up to 720 hours (30 days)" {...err('dueInHours')}>
            <Input
              type="number"
              inputMode="numeric"
              min={0}
              max={720}
              value={action.dueInHours}
              onChange={(e) => onChange({ ...action, dueInHours: Number(e.target.value) })}
            />
          </Field>
          <Field label="Priority">
            <Select
              value={action.priority}
              onChange={(e) =>
                onChange({ ...action, priority: e.target.value as (typeof PRIORITIES)[number] })
              }
            >
              {PRIORITIES.map((p) => (
                <option key={p} value={p}>
                  {PRIORITY_LABEL[p]}
                </option>
              ))}
            </Select>
          </Field>
          <MemberSelect
            label="Assignee"
            value={action.assigneeId}
            onChange={(v) => onChange({ ...action, assigneeId: v })}
            lookups={lookups}
            empty="The lead owner"
            {...err('assigneeId')}
          />
        </div>
      );
    case 'send_email': {
      const unit = unitFor(action.delayMinutes);
      return (
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Send to">
            <Select
              value={action.to}
              onChange={(e) => onChange({ ...action, to: e.target.value as 'lead' | 'owner' })}
            >
              <option value="lead">The lead</option>
              <option value="owner">The lead owner</option>
            </Select>
          </Field>
          <div className="grid grid-cols-[1fr_auto] items-end gap-2">
            <Field label="Send after" hint="Up to 30 days" {...err('delayMinutes')}>
              <Input
                type="number"
                inputMode="numeric"
                min={0}
                value={action.delayMinutes / unit}
                onChange={(e) =>
                  onChange({ ...action, delayMinutes: Math.round(Number(e.target.value) * unit) })
                }
              />
            </Field>
            <Field label="Unit">
              <Select
                value={unit}
                onChange={(e) =>
                  onChange({
                    ...action,
                    delayMinutes: (action.delayMinutes / unit) * Number(e.target.value),
                  })
                }
              >
                {DELAY_UNITS.map((u) => (
                  <option key={u.value} value={u.value}>
                    {u.label}
                  </option>
                ))}
              </Select>
            </Field>
          </div>
          <Field label="Subject" className="sm:col-span-2" {...err('subject')}>
            <Input
              value={action.subject}
              maxLength={200}
              onChange={(e) => onChange({ ...action, subject: e.target.value })}
            />
          </Field>
          <Field label="Email" hint={TEMPLATE_HINT} className="sm:col-span-2" {...err('body')}>
            <Textarea
              rows={5}
              value={action.body}
              onChange={(e) => onChange({ ...action, body: e.target.value })}
            />
          </Field>
        </div>
      );
    }
    case 'notify':
      return (
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Notify">
            <Select
              value={action.to}
              onChange={(e) =>
                onChange({
                  ...action,
                  to: e.target.value as 'owner' | 'admins' | 'user',
                  userId: e.target.value === 'user' ? action.userId : null,
                })
              }
            >
              <option value="owner">The lead owner</option>
              <option value="admins">Owners and Admins</option>
              <option value="user">One member</option>
            </Select>
          </Field>
          {action.to === 'user' ? (
            <MemberSelect
              label="Member"
              value={action.userId}
              onChange={(v) => onChange({ ...action, userId: v })}
              lookups={lookups}
              {...err('userId')}
            />
          ) : (
            <div aria-hidden />
          )}
          <Field label="Message" hint={TEMPLATE_HINT} className="sm:col-span-2" {...err('message')}>
            <Textarea
              rows={2}
              maxLength={500}
              value={action.message}
              onChange={(e) => onChange({ ...action, message: e.target.value })}
            />
          </Field>
        </div>
      );
    case 'update_field': {
      const setField = (field: string) => {
        if (field === 'priority') onChange({ type: 'update_field', field, value: 'HIGH' });
        if (field === 'stage') {
          const open = lookups.stages.find((s) => s.kind === 'OPEN');
          onChange({ type: 'update_field', field, value: open?.id ?? '' });
        }
        if (field === 'owner') onChange({ type: 'update_field', field, value: null });
        if (field === 'tags') onChange({ type: 'update_field', field, op: 'add', value: [] });
      };
      return (
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Field" hint="Workflows can change priority, stage, owner and tags">
            <Select value={action.field} onChange={(e) => setField(e.target.value)}>
              <option value="priority">Priority</option>
              <option value="stage">Stage</option>
              <option value="owner">Owner</option>
              <option value="tags">Tags</option>
            </Select>
          </Field>
          {action.field === 'priority' ? (
            <Field label="New priority">
              <Select
                value={action.value}
                onChange={(e) =>
                  onChange({ ...action, value: e.target.value as (typeof PRIORITIES)[number] })
                }
              >
                {PRIORITIES.map((p) => (
                  <option key={p} value={p}>
                    {PRIORITY_LABEL[p]}
                  </option>
                ))}
              </Select>
            </Field>
          ) : action.field === 'stage' ? (
            <Field
              label="New stage"
              hint="Open stages only. Won and Lost need a person"
              {...err('value')}
            >
              <Select
                value={action.value}
                onChange={(e) => onChange({ ...action, value: e.target.value })}
              >
                {lookups.stages
                  .filter((s) => s.kind === 'OPEN')
                  .map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name}
                    </option>
                  ))}
              </Select>
            </Field>
          ) : action.field === 'owner' ? (
            <MemberSelect
              label="New owner"
              value={action.value}
              onChange={(v) => onChange({ ...action, value: v })}
              lookups={lookups}
              empty="Nobody (the unassigned pool)"
              {...err('value')}
            />
          ) : (
            <div className="grid grid-cols-[auto_1fr] items-end gap-2">
              <Field label="Change">
                <Select
                  value={action.op}
                  onChange={(e) => onChange({ ...action, op: e.target.value as 'add' | 'remove' })}
                >
                  <option value="add">Add</option>
                  <option value="remove">Remove</option>
                </Select>
              </Field>
              <Field label="Tags" hint="Separate tags with commas" {...err('value')}>
                <Input
                  defaultValue={action.value.join(', ')}
                  onBlur={(e) =>
                    onChange({
                      ...action,
                      value: e.target.value
                        .split(',')
                        .map((t) => t.trim())
                        .filter(Boolean),
                    })
                  }
                />
              </Field>
            </div>
          )}
        </div>
      );
    }
  }
}

function Section({
  title,
  description,
  children,
}: {
  title: string;
  description: string;
  children: ReactNode;
}) {
  const id = useId();
  return (
    <Card aria-labelledby={id} className="flex flex-col gap-6">
      <div>
        <h2 id={id} className="display text-heading">
          {title}
        </h2>
        <p className="mt-2 text-obsidian/80">{description}</p>
      </div>
      {children}
    </Card>
  );
}

export interface BuilderValue {
  name: string;
  definition: Definition;
}

/**
 * The workflow builder (WF-01): one trigger, AND-ed conditions and up to 10 ordered actions.
 * Saving creates a new immutable version.
 */
export function Builder({
  initial,
  lookups,
  errors,
  saving,
  submitLabel,
  onSubmit,
}: {
  initial: BuilderValue;
  lookups: Lookups;
  errors: FieldErrors;
  saving: boolean;
  submitLabel: string;
  onSubmit: (value: BuilderValue) => void;
}) {
  const [name, setName] = useState(initial.name);
  const [trigger, setTrigger] = useState<Trigger>(initial.definition.trigger);
  const [conditions, setConditions] = useState<Condition[]>(initial.definition.conditions);
  const [actions, setActions] = useState<Action[]>(initial.definition.actions);
  // Stable keys, so moving an action keeps its fields in place.
  const [keys, setKeys] = useState(() => initial.definition.actions.map(() => crypto.randomUUID()));

  const top = errors.filter(
    (e) =>
      e.path === 'body.definition' ||
      e.path === 'body.definition.actions' ||
      e.path === 'body.definition.conditions' ||
      e.path === '(root)',
  );

  function move(i: number, by: -1 | 1) {
    const j = i + by;
    const swap = <T,>(list: T[]) => {
      const next = [...list];
      [next[i], next[j]] = [next[j]!, next[i]!];
      return next;
    };
    setActions(swap);
    setKeys(swap);
  }

  return (
    <form
      className="flex flex-col gap-6"
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit({ name, definition: { trigger, conditions, actions } });
      }}
    >
      <Card density="dense" className="flex flex-col gap-4">
        <Field
          label="Workflow name"
          {...(first(errors, 'body.name') ? { error: first(errors, 'body.name')! } : {})}
        >
          <Input value={name} maxLength={80} onChange={(e) => setName(e.target.value)} required />
        </Field>
      </Card>

      <Section title="When" description="The event that starts the workflow">
        <Field label="Trigger">
          <Select value={trigger} onChange={(e) => setTrigger(e.target.value as Trigger)}>
            {TRIGGERS.map((t) => (
              <option key={t} value={t}>
                {TRIGGER_LABEL[t]}
              </option>
            ))}
          </Select>
        </Field>
      </Section>

      <Section
        title="Only if"
        description={
          trigger === 'task.deadline_reached'
            ? 'All conditions must hold. Assignee means the next step’s assignee; the rest are about its lead'
            : 'All conditions must hold. Leave empty to run for every event'
        }
      >
        {conditions.length ? (
          <ol className="flex flex-col gap-4" aria-label="Conditions">
            {conditions.map((c, i) => {
              const path = `body.definition.conditions.${i}`;
              const choices = options(c.field, lookups);
              return (
                <li key={i} className="flex flex-col gap-4 rounded-medium bg-pumice p-4 sm:p-6">
                  <div className="grid gap-4 sm:grid-cols-[1fr_1fr_auto] sm:items-end">
                    <Field label={`Condition ${i + 1}`}>
                      <Select
                        value={c.field}
                        onChange={(e) => {
                          const field = e.target.value as ConditionField;
                          setConditions(
                            conditions.map((x, k) =>
                              k === i ? { ...x, field, values: defaultValues(field, lookups) } : x,
                            ),
                          );
                        }}
                      >
                        {CONDITION_FIELDS.map((f) => (
                          <option key={f} value={f}>
                            {CONDITION_FIELD_LABEL[f]}
                          </option>
                        ))}
                      </Select>
                    </Field>
                    <Field label="Rule">
                      <Select
                        value={c.operator}
                        onChange={(e) => {
                          const operator = e.target.value as Condition['operator'];
                          setConditions(
                            conditions.map((x, k) =>
                              k === i
                                ? {
                                    ...x,
                                    operator,
                                    values: operator === 'is' ? x.values.slice(0, 1) : x.values,
                                  }
                                : x,
                            ),
                          );
                        }}
                      >
                        {CONDITION_OPERATORS.map((o) => (
                          <option key={o} value={o}>
                            {CONDITION_OPERATOR_LABEL[o]}
                          </option>
                        ))}
                      </Select>
                    </Field>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={() => setConditions(conditions.filter((_, k) => k !== i))}
                    >
                      <Trash2 aria-hidden className="size-4" strokeWidth={1.75} />
                      Remove
                      <span className="sr-only"> condition {i + 1}</span>
                    </Button>
                  </div>
                  {c.operator === 'is' ? (
                    <Field
                      label="Value"
                      {...(first(errors, path) ? { error: first(errors, path)! } : {})}
                    >
                      <Select
                        value={c.values[0] ?? ''}
                        onChange={(e) =>
                          setConditions(
                            conditions.map((x, k) =>
                              k === i ? { ...x, values: [e.target.value] } : x,
                            ),
                          )
                        }
                      >
                        {choices.map((o) => (
                          <option key={o.value} value={o.value}>
                            {o.label}
                          </option>
                        ))}
                      </Select>
                    </Field>
                  ) : (
                    <Checks
                      legend="Values"
                      items={choices}
                      value={c.values}
                      onChange={(values) =>
                        setConditions(conditions.map((x, k) => (k === i ? { ...x, values } : x)))
                      }
                      {...(first(errors, path) ? { error: first(errors, path)! } : {})}
                    />
                  )}
                </li>
              );
            })}
          </ol>
        ) : null}
        <div>
          <Button
            type="button"
            variant="secondary"
            disabled={conditions.length >= MAX_CONDITIONS}
            onClick={() =>
              setConditions([
                ...conditions,
                { field: 'source', operator: 'is', values: defaultValues('source', lookups) },
              ])
            }
          >
            <Plus aria-hidden className="size-4" strokeWidth={1.75} />
            Add a condition
          </Button>
        </div>
      </Section>

      <Section
        title="Then"
        description={`Up to ${MAX_ACTIONS} actions, run in this order. A step that succeeded is never run twice`}
      >
        {actions.length ? (
          <ol className="flex flex-col gap-4" aria-label="Actions">
            {actions.map((a, i) => {
              const path = `body.definition.actions.${i}`;
              return (
                <li
                  key={keys[i]}
                  className="flex flex-col gap-4 rounded-medium bg-pumice p-4 sm:p-6"
                >
                  <div className="grid gap-4 sm:grid-cols-[1fr_auto] sm:items-end">
                    <Field label={`Action ${i + 1}`}>
                      <Select
                        value={a.type}
                        onChange={(e) =>
                          setActions(
                            actions.map((x, k) =>
                              k === i ? newAction(e.target.value as ActionType) : x,
                            ),
                          )
                        }
                      >
                        {ACTION_TYPES.map((t) => (
                          <option key={t} value={t}>
                            {ACTION_LABEL[t]}
                          </option>
                        ))}
                      </Select>
                    </Field>
                    <div className="flex flex-wrap gap-1">
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        disabled={i === 0}
                        onClick={() => move(i, -1)}
                        aria-label={`Move action ${i + 1} up`}
                      >
                        <ArrowUp aria-hidden className="size-4" strokeWidth={1.75} />
                      </Button>
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        disabled={i === actions.length - 1}
                        onClick={() => move(i, 1)}
                        aria-label={`Move action ${i + 1} down`}
                      >
                        <ArrowDown aria-hidden className="size-4" strokeWidth={1.75} />
                      </Button>
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        onClick={() => {
                          setActions(actions.filter((_, k) => k !== i));
                          setKeys(keys.filter((_, k) => k !== i));
                        }}
                      >
                        <Trash2 aria-hidden className="size-4" strokeWidth={1.75} />
                        Remove
                        <span className="sr-only"> action {i + 1}</span>
                      </Button>
                    </div>
                  </div>
                  <ActionFields
                    action={a}
                    onChange={(next) => setActions(actions.map((x, k) => (k === i ? next : x)))}
                    lookups={lookups}
                    errors={errors}
                    path={path}
                  />
                  {errorsAt(errors, path)
                    .filter((e) => e.path === path || e.path === `${path}.type`)
                    .map((e) => (
                      <p key={e.message} role="alert" className="px-5 text-body-sm">
                        {e.message}
                      </p>
                    ))}
                </li>
              );
            })}
          </ol>
        ) : (
          <p className="text-obsidian/80">No actions yet. A workflow needs at least one</p>
        )}
        <div>
          <Button
            type="button"
            variant="secondary"
            disabled={actions.length >= MAX_ACTIONS}
            onClick={() => {
              setActions([...actions, newAction('create_task')]);
              setKeys([...keys, crypto.randomUUID()]);
            }}
          >
            <Plus aria-hidden className="size-4" strokeWidth={1.75} />
            Add an action
          </Button>
        </div>
      </Section>

      {top.length ? (
        <div role="alert" className="rounded-medium bg-sulfur p-4 sm:p-6">
          {top.map((e) => (
            <p key={e.message}>{e.message}</p>
          ))}
        </div>
      ) : errors.length ? (
        <p role="alert" className="rounded-medium bg-sulfur p-4 sm:p-6">
          Some fields need attention. They are marked above
        </p>
      ) : null}

      <div>
        <Button type="submit" loading={saving}>
          {submitLabel}
        </Button>
      </div>
    </form>
  );
}
