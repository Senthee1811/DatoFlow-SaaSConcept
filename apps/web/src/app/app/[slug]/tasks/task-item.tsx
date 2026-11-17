'use client';

import { TASK_TYPE_LABEL, endOfToday } from '@datoflow/domain';
import type { TaskDto } from '@datoflow/shared';
import { Button, StatusBadge } from '@datoflow/ui';
import Link from 'next/link';
import { formatInOrgTime } from '@/lib/org-context';

/** Overdue = Ember with an icon and the word; due today = Sulfur. Never colour alone. */
export function DueBadge({ task, timezone }: { task: TaskDto; timezone: string }) {
  if (task.status !== 'OPEN') return null;
  if (task.overdue) return <StatusBadge status="attention">Overdue</StatusBadge>;
  if (Date.parse(task.dueAt) < endOfToday(new Date(), timezone).getTime())
    return <StatusBadge status="today">Due today</StatusBadge>;
  return null;
}

/** One task: what, when, for which lead, who does it, and a Done button when it can be done. */
export function TaskItem({
  task,
  slug,
  timezone,
  showLead = true,
  onDone,
  busy,
}: {
  task: TaskDto;
  slug: string;
  timezone: string;
  showLead?: boolean;
  onDone?: (task: TaskDto) => void;
  busy?: boolean;
}) {
  return (
    <li className="flex flex-wrap items-center justify-between gap-3 rounded-medium bg-pumice px-4 py-3">
      <div className="min-w-0 flex-1">
        <p className="flex flex-wrap items-center gap-2">
          <span className="break-words">{task.title}</span>
          <DueBadge task={task} timezone={timezone} />
        </p>
        <p className="mt-1 text-body-sm text-obsidian/80">
          {TASK_TYPE_LABEL[task.type]} ·{' '}
          <time dateTime={task.dueAt} className="tabular">
            {formatInOrgTime(task.dueAt, timezone, { year: undefined })}
          </time>
          {showLead ? (
            <>
              {' · '}
              <Link
                href={`/app/${slug}/leads/${task.leadId}`}
                className="underline decoration-dotted underline-offset-4"
              >
                {task.leadName}
              </Link>
              {task.leadCompany ? `, ${task.leadCompany}` : ''}
            </>
          ) : null}
          {task.assigneeName ? ` · ${task.assigneeName}` : ''}
        </p>
      </div>
      {onDone && task.canEdit && task.status === 'OPEN' ? (
        <Button
          variant="secondary"
          size="sm"
          loading={busy}
          onClick={() => onDone(task)}
          aria-label={`Mark "${task.title}" as done`}
        >
          Done
        </Button>
      ) : null}
    </li>
  );
}
