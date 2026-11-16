'use client';

import type { AuditLogDto, Page } from '@datoflow/shared';
import { Button, Card } from '@datoflow/ui';
import { useCallback, useEffect, useState } from 'react';
import { api, problemMessage } from '@/lib/api';
import { formatInOrgTime, useOrg } from '@/lib/org-context';
import { PageHeader } from '../page-header';

const ACTIONS: Record<string, string> = {
  'auth.signed_in': 'Signed in',
  'auth.sign_in_failed': 'Failed sign-in',
  'auth.signed_out': 'Signed out',
  'auth.password_reset': 'Reset password',
  'auth.sessions_revoked': 'Signed out all devices',
  'org.created': 'Created the workspace',
  'org.updated': 'Changed workspace settings',
  'member.role_changed': 'Changed a role',
  'member.removed': 'Removed a member',
  'invitation.created': 'Sent an invitation',
  'invitation.resent': 'Resent an invitation',
  'invitation.revoked': 'Withdrew an invitation',
  'invitation.accepted': 'Accepted an invitation',
};

function detail(entry: AuditLogDto): string | null {
  const m = entry.metadata;
  if (entry.action === 'member.role_changed') return `${String(m.from)} to ${String(m.to)}`;
  if (entry.action.startsWith('invitation.') && typeof m.email === 'string') {
    return m.role ? `${m.email} as ${String(m.role)}` : m.email;
  }
  if (entry.action === 'org.updated' && Array.isArray(m.fields)) return m.fields.join(', ');
  return null;
}

export default function AuditPage() {
  const { org } = useOrg();
  const [entries, setEntries] = useState<AuditLogDto[] | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(
    async (after: string | null) => {
      setLoading(true);
      try {
        const page = await api<Page<AuditLogDto>>(
          `/v1/orgs/${org.id}/audit-logs?limit=50${after ? `&cursor=${after}` : ''}`,
        );
        setEntries((prev) => (after && prev ? [...prev, ...page.items] : page.items));
        setCursor(page.nextCursor);
      } catch (e) {
        setError(problemMessage(e));
      } finally {
        setLoading(false);
      }
    },
    [org.id],
  );

  useEffect(() => {
    void load(null);
  }, [load]);

  return (
    <>
      <PageHeader
        title="Audit log"
        description={`Sign-ins, roles and invitations. Times in ${org.timezone.replaceAll('_', ' ')}`}
      />
      <Card>
        {error ? <p role="alert">{error}</p> : null}
        {!entries ? (
          <p aria-live="polite">Loading the audit log</p>
        ) : entries.length === 0 ? (
          <p>Nothing recorded yet</p>
        ) : (
          <ol className="flex flex-col" aria-label="Audit entries">
            {entries.map((e) => (
              <li
                key={e.id}
                className="divider grid gap-1 py-3 first:border-t-0 sm:grid-cols-[11rem_1fr_auto] sm:gap-4"
              >
                <time dateTime={e.createdAt} className="tabular text-body-sm text-obsidian/75">
                  {formatInOrgTime(e.createdAt, org.timezone)}
                </time>
                <p className="min-w-0">
                  <span>{e.actorName ?? 'Someone outside the workspace'}</span>{' '}
                  <span className="text-obsidian/80">
                    {(ACTIONS[e.action] ?? e.action).toLowerCase()}
                  </span>
                  {detail(e) ? (
                    <span className="block truncate text-body-sm text-obsidian/75">
                      {detail(e)}
                    </span>
                  ) : null}
                </p>
                <span className="caption tabular text-obsidian/70">{e.ip ?? ''}</span>
              </li>
            ))}
          </ol>
        )}
        {cursor ? (
          <div className="mt-6">
            <Button variant="secondary" loading={loading} onClick={() => load(cursor)}>
              Load older entries
            </Button>
          </div>
        ) : null}
      </Card>
    </>
  );
}
