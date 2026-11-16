'use client';

import { can, planFor, ROLE_LABEL } from '@datoflow/domain';
import { buttonClass, Card, Halftone } from '@datoflow/ui';
import Link from 'next/link';
import { useOrg } from '@/lib/org-context';
import { PageHeader } from './page-header';

export default function OverviewPage() {
  const { org, me } = useOrg();
  const plan = planFor(org.planCode);
  const canInvite = can(org.role, 'members.manage');

  return (
    <>
      <PageHeader
        title={org.name}
        description={`Signed in as ${me.name}, ${ROLE_LABEL[org.role]}`}
      />

      {canInvite ? (
        <Halftone className="grid gap-6 p-6 sm:p-10 md:grid-cols-[3fr_2fr]">
          <div className="relative z-10 flex flex-col gap-4 rounded-medium bg-limestone p-6">
            <h2 className="display text-heading">Bring in your team</h2>
            <p>
              Invite the people who follow up on leads. Each one gets a role: Owner, Admin, Sales
              Manager or Sales Rep.
            </p>
            <div>
              <Link href={`/app/${org.slug}/members`} className={buttonClass('primary')}>
                Invite teammates
              </Link>
            </div>
          </div>
        </Halftone>
      ) : null}

      {org.hasSampleData ? (
        <Card density="dense" className="flex flex-wrap items-center justify-between gap-4">
          <p className="max-w-2xl">
            This workspace holds sample data: a fictional agency with 60 leads and 3 reps. Try the
            board and the filters on it, then delete it when your own leads arrive.
          </p>
          <div className="flex flex-wrap gap-2">
            <Link href={`/app/${org.slug}/leads`} className={buttonClass('secondary')}>
              Open the leads
            </Link>
            {can(org.role, 'org.settings') ? (
              <Link href={`/app/${org.slug}/settings`} className={buttonClass('ghost')}>
                Delete sample data
              </Link>
            ) : null}
          </div>
        </Card>
      ) : null}

      <div className="grid gap-4 md:grid-cols-3">
        <Card density="dense" className="flex flex-col gap-2">
          <h2 className="text-body-sm">Timezone</h2>
          <p className="text-subheading">{org.timezone.replaceAll('_', ' ')}</p>
        </Card>
        <Card density="dense" className="flex flex-col gap-2">
          <h2 className="text-body-sm">Currency</h2>
          <p className="text-subheading">{org.currency}</p>
        </Card>
        <Card density="dense" className="flex flex-col gap-2">
          <h2 className="text-body-sm">Plan</h2>
          <p className="text-subheading">{plan.name}</p>
          <p className="caption text-obsidian/75">
            Up to <span className="tabular">{plan.limits.users}</span> users
          </p>
        </Card>
      </div>
    </>
  );
}
