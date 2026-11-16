'use client';

import { ROLE_LABEL } from '@datoflow/domain';
import type { InvitationPreviewDto, InvitationProblem } from '@datoflow/shared';
import { Button, buttonClass } from '@datoflow/ui';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import { api, ApiProblem, problemMessage } from '@/lib/api';
import { authClient } from '@/lib/auth-client';

const PROBLEM_TEXT: Record<InvitationProblem | 'NOT_FOUND', string> = {
  NOT_FOUND: 'This invitation link does not work. It may have been replaced by a newer one',
  EXPIRED: 'This invitation has expired. Invitations work for 7 days',
  USED: 'This invitation was already used',
  REVOKED: 'This invitation was withdrawn',
  EMAIL_MISMATCH: 'This invitation was sent to a different email address',
};

function AskForNewInvite({
  reason,
  organizationName,
}: {
  reason: InvitationProblem | 'NOT_FOUND';
  organizationName?: string;
}) {
  return (
    <>
      <h1 className="display mb-4 text-heading-lg">Ask for a new invite</h1>
      <p className="mb-8 max-w-md">
        {PROBLEM_TEXT[reason]}. Ask the person who invited you
        {organizationName ? ` to ${organizationName}` : ''} to send a new one.
      </p>
      <Link href="/app" className={buttonClass('secondary')}>
        Go to DatoFlow
      </Link>
    </>
  );
}

export function InviteView({ token }: { token: string }) {
  const router = useRouter();
  const session = authClient.useSession();
  const [preview, setPreview] = useState<InvitationPreviewDto | null>(null);
  const [missing, setMissing] = useState(false);
  const [accepting, setAccepting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setPreview(await api<InvitationPreviewDto>(`/v1/invitations/${encodeURIComponent(token)}`));
    } catch (e) {
      if (e instanceof ApiProblem && e.status === 404) setMissing(true);
      else setError(problemMessage(e));
    }
  }, [token]);

  useEffect(() => {
    if (!session.isPending) void load();
  }, [load, session.isPending, session.data?.user.id]);

  if (missing) return <AskForNewInvite reason="NOT_FOUND" />;
  if (!preview || session.isPending) {
    return <p aria-live="polite">{error ?? 'Loading the invitation'}</p>;
  }
  if (preview.problem && preview.problem !== 'EMAIL_MISMATCH') {
    return <AskForNewInvite reason={preview.problem} organizationName={preview.organizationName} />;
  }

  const user = session.data?.user;
  const here = `/invite/${token}`;
  const role = ROLE_LABEL[preview.role];

  async function accept() {
    setAccepting(true);
    setError(null);
    try {
      const result = await api<{ organizationId: string; organizationSlug: string }>(
        `/v1/invitations/${encodeURIComponent(token)}/accept`,
        { method: 'POST', body: {} },
      );
      await authClient.organization.setActive({ organizationId: result.organizationId });
      router.replace(`/app/${result.organizationSlug}`);
    } catch (e) {
      const reason =
        e instanceof ApiProblem ? (e.problem.reason as InvitationProblem | undefined) : undefined;
      if (reason) setPreview({ ...preview!, problem: reason });
      else setError(problemMessage(e));
      setAccepting(false);
    }
  }

  return (
    <>
      <p className="mb-3 text-body-sm">Invitation</p>
      <h1 className="display mb-4 text-heading-lg">Join {preview.organizationName}</h1>
      <p className="mb-8 max-w-md">
        You are invited as <strong className="font-medium">{role}</strong>. The invitation is for{' '}
        <strong className="font-medium">{preview.email}</strong>.
      </p>

      {!user ? (
        <div className="flex flex-wrap gap-2">
          <Link
            href={`/sign-up?email=${encodeURIComponent(preview.email)}&next=${encodeURIComponent(here)}`}
            className={buttonClass('primary')}
          >
            Create account
          </Link>
          <Link
            href={`/sign-in?email=${encodeURIComponent(preview.email)}&next=${encodeURIComponent(here)}`}
            className={buttonClass('secondary')}
          >
            Sign in
          </Link>
        </div>
      ) : preview.problem === 'EMAIL_MISMATCH' ? (
        <div className="flex flex-col gap-4">
          <p role="alert" className="rounded-medium bg-sulfur px-5 py-3 text-body-sm">
            You are signed in as {user.email}. Sign in as {preview.email} to accept, or ask for a
            new invite sent to your address.
          </p>
          <div>
            <Button
              variant="secondary"
              onClick={async () => {
                await authClient.signOut();
                router.refresh();
              }}
            >
              Sign out
            </Button>
          </div>
        </div>
      ) : (
        <div className="flex flex-col gap-4">
          {error ? (
            <p role="alert" className="rounded-medium bg-sulfur px-5 py-3 text-body-sm">
              {error}
            </p>
          ) : null}
          <div>
            <Button onClick={accept} loading={accepting}>
              Accept and join
            </Button>
          </div>
        </div>
      )}
    </>
  );
}
