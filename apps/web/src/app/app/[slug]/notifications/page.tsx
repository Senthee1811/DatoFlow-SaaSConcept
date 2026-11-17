'use client';

import { ROLE_LABEL, type Role } from '@datoflow/domain';
import type { NotificationDto, Page } from '@datoflow/shared';
import { Badge, Button, Card } from '@datoflow/ui';
import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { api, problemMessage } from '@/lib/api';
import { formatInOrgTime, useOrg } from '@/lib/org-context';
import { PageHeader } from '../page-header';
import { NOTIFICATIONS_CHANGED } from '../workspace-shell';

/** The notification centre (NOT-01). */
export default function NotificationsPage() {
  const { org } = useOrg();
  const [items, setItems] = useState<NotificationDto[] | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const base = `/v1/orgs/${org.id}/notifications`;

  const load = useCallback(
    async (after: string | null) => {
      try {
        const page = await api<Page<NotificationDto>>(
          `${base}?limit=30${after ? `&cursor=${after}` : ''}`,
        );
        setItems((prev) => (after && prev ? [...prev, ...page.items] : page.items));
        setCursor(page.nextCursor);
      } catch (e) {
        toast(problemMessage(e));
      }
    },
    [base],
  );

  useEffect(() => {
    void load(null);
  }, [load]);

  async function markRead(n: NotificationDto) {
    if (n.readAt) return;
    try {
      await api(`${base}/${n.id}/read`, { method: 'POST', body: {} });
      setItems(
        (prev) =>
          prev?.map((x) => (x.id === n.id ? { ...x, readAt: new Date().toISOString() } : x)) ??
          null,
      );
      window.dispatchEvent(new Event(NOTIFICATIONS_CHANGED));
    } catch (e) {
      toast(problemMessage(e));
    }
  }

  async function markAll() {
    try {
      await api(`${base}/read-all`, { method: 'POST', body: {} });
      const now = new Date().toISOString();
      setItems((prev) => prev?.map((x) => ({ ...x, readAt: x.readAt ?? now })) ?? null);
      window.dispatchEvent(new Event(NOTIFICATIONS_CHANGED));
    } catch (e) {
      toast(problemMessage(e));
    }
  }

  const unread = items?.filter((n) => !n.readAt).length ?? 0;

  return (
    <>
      <PageHeader
        title="Notifications"
        description="Reminders 15 minutes before your next steps, workflow messages, and news about your workspace"
        actions={
          unread ? (
            <Button variant="secondary" onClick={markAll}>
              Mark all as read
            </Button>
          ) : null
        }
      />
      <Card density="dense">
        {!items ? (
          <p aria-live="polite">Loading notifications</p>
        ) : items.length === 0 ? (
          <p>No notifications yet. Reminders for your next steps will appear here.</p>
        ) : (
          <ul aria-label="Notifications" className="flex flex-col">
            {items.map((n) => (
              <li
                key={n.id}
                className="divider flex flex-wrap items-start justify-between gap-3 py-4 first:border-t-0"
              >
                <div className="min-w-0 flex-1">
                  <p className="flex flex-wrap items-center gap-2">
                    {!n.readAt ? <Badge tone="sulfur">New</Badge> : null}
                    <NotificationText n={n} slug={org.slug} onOpen={() => void markRead(n)} />
                  </p>
                  <time dateTime={n.createdAt} className="caption tabular text-obsidian/75">
                    {formatInOrgTime(n.createdAt, org.timezone)}
                  </time>
                </div>
                {!n.readAt ? (
                  <Button variant="ghost" size="sm" onClick={() => void markRead(n)}>
                    Mark as read
                  </Button>
                ) : null}
              </li>
            ))}
          </ul>
        )}
        {cursor ? (
          <Button variant="ghost" size="sm" onClick={() => load(cursor)}>
            Show older
          </Button>
        ) : null}
      </Card>
    </>
  );
}

function NotificationText({
  n,
  slug,
  onOpen,
}: {
  n: NotificationDto;
  slug: string;
  onOpen: () => void;
}) {
  const p = n.payload;
  const { org } = useOrg();
  if (n.kind === 'TASK_DUE_SOON') {
    return (
      <span>
        Due at{' '}
        {formatInOrgTime(String(p.dueAt), org.timezone, {
          day: undefined,
          month: undefined,
          year: undefined,
        })}
        :{' '}
        <Link
          href={`/app/${slug}/leads/${String(p.leadId)}`}
          onClick={onOpen}
          className="underline decoration-dotted underline-offset-4"
        >
          {String(p.title)}, {String(p.leadName)}
        </Link>
      </span>
    );
  }
  if (n.kind === 'WORKFLOW_MESSAGE') {
    return (
      <span>
        {String(p.message)}{' '}
        <Link
          href={`/app/${slug}/leads/${String(p.leadId)}`}
          onClick={onOpen}
          className="underline decoration-dotted underline-offset-4"
        >
          Open {String(p.leadName)}
        </Link>
        <span className="caption text-obsidian/75"> · Workflow: {String(p.workflowName)}</span>
      </span>
    );
  }
  if (n.kind === 'WORKFLOW_DEAD') {
    return (
      <span>
        Workflow &ldquo;{String(p.workflowName)}&rdquo; gave up
        {p.leadName ? ` on ${String(p.leadName)}` : ''}: {String(p.error)}.{' '}
        <Link
          href={`/app/${slug}/workflows/runs/${String(p.executionId)}`}
          onClick={onOpen}
          className="underline decoration-dotted underline-offset-4"
        >
          See the run and retry
        </Link>
      </span>
    );
  }
  if (n.kind === 'MEMBER_JOINED') {
    return (
      <span>
        {String(p.name)} joined as {ROLE_LABEL[p.role as Role] ?? 'a member'}
      </span>
    );
  }
  return <span>{String(n.kind).toLowerCase().replaceAll('_', ' ')}</span>;
}
