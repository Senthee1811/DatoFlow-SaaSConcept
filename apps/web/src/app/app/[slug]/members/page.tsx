'use client';

import { canGrantRole, canManageMember, ROLE_LABEL, ROLES, type Role } from '@datoflow/domain';
import type { InvitationDto, MemberDto, Page } from '@datoflow/shared';
import { Badge, Button, Card, Field, Input, Select, StatusBadge } from '@datoflow/ui';
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { toast } from 'sonner';
import { api, ApiProblem, problemMessage } from '@/lib/api';
import { formatInOrgTime, useOrg } from '@/lib/org-context';
import { PageHeader } from '../page-header';

export default function MembersPage() {
  const { org, me } = useOrg();
  const [members, setMembers] = useState<MemberDto[] | null>(null);
  const [invitations, setInvitations] = useState<InvitationDto[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const base = `/v1/orgs/${org.id}`;

  const load = useCallback(async () => {
    try {
      const [m, i] = await Promise.all([
        api<Page<MemberDto>>(`${base}/members?limit=100`),
        api<Page<InvitationDto>>(`${base}/invitations?limit=100`),
      ]);
      setMembers(m.items);
      setInvitations(i.items);
    } catch (e) {
      setLoadError(problemMessage(e));
    }
  }, [base]);

  useEffect(() => {
    void load();
  }, [load]);

  const grantable = ROLES.filter((r) => canGrantRole(org.role, r));
  const pending = invitations.filter((i) => i.status === 'PENDING');
  const closed = invitations.filter((i) => i.status !== 'PENDING').slice(0, 10);

  return (
    <>
      <PageHeader
        title="Members"
        description="Who works in this workspace and what each person can do"
      />
      <InviteForm base={base} roles={grantable} onInvited={load} />

      <Card>
        <h2 className="display mb-6 text-heading">Team</h2>
        {loadError ? <p role="alert">{loadError}</p> : null}
        {!members ? (
          <p aria-live="polite">Loading members</p>
        ) : (
          <ul className="flex flex-col" aria-label="Members">
            {members.map((m) => (
              <MemberRow
                key={m.id}
                member={m}
                isSelf={m.userId === me.id}
                actorRole={org.role}
                grantable={grantable}
                base={base}
                onChanged={load}
              />
            ))}
          </ul>
        )}
      </Card>

      <Card>
        <h2 className="display mb-6 text-heading">Invitations</h2>
        {pending.length === 0 ? (
          <p className="text-obsidian/80">No open invitations</p>
        ) : (
          <ul className="flex flex-col" aria-label="Open invitations">
            {pending.map((inv) => (
              <InvitationRow
                key={inv.id}
                invitation={inv}
                base={base}
                timezone={org.timezone}
                onChanged={load}
              />
            ))}
          </ul>
        )}
        {closed.length > 0 ? (
          <details className="mt-6">
            <summary className="cursor-pointer rounded-pills px-3 py-2 text-body-sm">
              Recent closed invitations
            </summary>
            <ul className="mt-2 flex flex-col">
              {closed.map((inv) => (
                <li
                  key={inv.id}
                  className="divider flex flex-wrap items-center gap-3 py-3 first:border-t-0"
                >
                  <span className="min-w-0 flex-1 truncate">{inv.email}</span>
                  <span className="text-body-sm">{ROLE_LABEL[inv.role]}</span>
                  <StatusBadge status={inv.status === 'ACCEPTED' ? 'done' : 'today'}>
                    {inv.status === 'ACCEPTED'
                      ? 'Accepted'
                      : inv.status === 'REVOKED'
                        ? 'Withdrawn'
                        : 'Expired'}
                  </StatusBadge>
                </li>
              ))}
            </ul>
          </details>
        ) : null}
      </Card>
    </>
  );
}

function InviteForm({
  base,
  roles,
  onInvited,
}: {
  base: string;
  roles: Role[];
  onInvited: () => Promise<void>;
}) {
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<Role>('REP');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<{ field?: string; message: string } | null>(null);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setSending(true);
    setError(null);
    try {
      await api(`${base}/invitations`, { method: 'POST', body: { email, role } });
      toast(`Invitation sent to ${email.trim().toLowerCase()}`);
      setEmail('');
      await onInvited();
    } catch (e) {
      if (e instanceof ApiProblem && e.fieldErrors.email)
        setError({ field: 'email', message: e.fieldErrors.email });
      else setError({ message: problemMessage(e) });
    } finally {
      setSending(false);
    }
  }

  return (
    <Card tone="limestone">
      <h2 className="display mb-6 text-heading">Invite a teammate</h2>
      <form onSubmit={submit} className="grid items-start gap-4 md:grid-cols-[2fr_1fr_auto]">
        <Field label="Email" error={error?.field === 'email' ? error.message : undefined}>
          <Input
            type="email"
            required
            autoComplete="off"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
        </Field>
        <Field label="Role">
          <Select value={role} onChange={(e) => setRole(e.target.value as Role)}>
            {roles.map((r) => (
              <option key={r} value={r}>
                {ROLE_LABEL[r]}
              </option>
            ))}
          </Select>
        </Field>
        <div className="md:pt-8">
          <Button type="submit" loading={sending}>
            Send invite
          </Button>
        </div>
        {error && !error.field ? (
          <p role="alert" className="rounded-medium bg-sulfur px-5 py-3 text-body-sm md:col-span-3">
            {error.message}
          </p>
        ) : null}
      </form>
    </Card>
  );
}

function MemberRow({
  member,
  isSelf,
  actorRole,
  grantable,
  base,
  onChanged,
}: {
  member: MemberDto;
  isSelf: boolean;
  actorRole: Role;
  grantable: Role[];
  base: string;
  onChanged: () => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const manageable = canManageMember(actorRole, member.role);

  async function run(action: () => Promise<unknown>, success: string) {
    setBusy(true);
    try {
      await action();
      toast(success);
      await onChanged();
    } catch (e) {
      toast(problemMessage(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <li className="divider flex flex-col gap-3 py-4 first:border-t-0 sm:flex-row sm:items-center">
      <div className="min-w-0 flex-1">
        <p className="truncate">
          {member.name}
          {isSelf ? <span className="text-obsidian/70"> (you)</span> : null}
        </p>
        <p className="truncate text-body-sm text-obsidian/75">{member.email}</p>
      </div>
      {manageable ? (
        <div className="w-full sm:w-52">
          <label className="sr-only" htmlFor={`role-${member.id}`}>
            Role for {member.name}
          </label>
          <Select
            id={`role-${member.id}`}
            value={member.role}
            disabled={busy}
            className="min-h-11"
            onChange={(e) =>
              run(
                () =>
                  api(`${base}/members/${member.id}`, {
                    method: 'PATCH',
                    body: { role: e.target.value },
                  }),
                `${member.name} is now ${ROLE_LABEL[e.target.value as Role]}`,
              )
            }
          >
            {(grantable.includes(member.role) ? grantable : [member.role, ...grantable]).map(
              (r) => (
                <option key={r} value={r}>
                  {ROLE_LABEL[r]}
                </option>
              ),
            )}
          </Select>
        </div>
      ) : (
        <Badge tone="limestone">{ROLE_LABEL[member.role]}</Badge>
      )}
      {manageable ? (
        <Button
          variant="quiet-danger"
          size="sm"
          disabled={busy}
          onClick={() => {
            const question = isSelf
              ? 'Leave this workspace?'
              : `Remove ${member.name} from this workspace?`;
            if (window.confirm(question)) {
              void run(
                () => api(`${base}/members/${member.id}`, { method: 'DELETE' }),
                `${member.name} was removed`,
              );
            }
          }}
        >
          {isSelf ? 'Leave' : 'Remove'}
        </Button>
      ) : null}
    </li>
  );
}

function InvitationRow({
  invitation,
  base,
  timezone,
  onChanged,
}: {
  invitation: InvitationDto;
  base: string;
  timezone: string;
  onChanged: () => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const expired = invitation.status === 'EXPIRED';

  async function run(path: string, success: string) {
    setBusy(true);
    try {
      await api(`${base}/invitations/${invitation.id}/${path}`, { method: 'POST', body: {} });
      toast(success);
      await onChanged();
    } catch (e) {
      toast(problemMessage(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <li className="divider flex flex-col gap-3 py-4 first:border-t-0 sm:flex-row sm:items-center">
      <div className="min-w-0 flex-1">
        <p className="truncate">{invitation.email}</p>
        <p className="text-body-sm text-obsidian/75">
          {ROLE_LABEL[invitation.role]} · expires {formatInOrgTime(invitation.expiresAt, timezone)}
        </p>
      </div>
      {expired ? <StatusBadge status="attention">Expired</StatusBadge> : null}
      <div className="flex gap-1">
        <Button
          variant="ghost"
          size="sm"
          disabled={busy}
          onClick={() => run('resend', `Invitation sent again to ${invitation.email}`)}
        >
          Resend
        </Button>
        <Button
          variant="quiet-danger"
          size="sm"
          disabled={busy}
          onClick={() => run('revoke', 'Invitation withdrawn')}
        >
          Withdraw
        </Button>
      </div>
    </li>
  );
}
