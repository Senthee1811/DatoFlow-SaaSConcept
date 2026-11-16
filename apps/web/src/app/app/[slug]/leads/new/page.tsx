'use client';

import { can } from '@datoflow/domain';
import type { LeadDto } from '@datoflow/shared';
import { Card } from '@datoflow/ui';
import { useRouter } from 'next/navigation';
import { api } from '@/lib/api';
import { useLookups } from '@/lib/lookups';
import { useOrg } from '@/lib/org-context';
import { PageHeader } from '../../page-header';
import { initialValues, LeadForm, toBody } from '../lead-form';

export default function NewLeadPage() {
  const { org, me } = useOrg();
  const router = useRouter();
  const { lookups, error } = useLookups(org.id);

  return (
    <>
      <PageHeader
        title="New lead"
        description="It lands in the first stage, owned by you unless you choose someone else"
      />
      <Card className="max-w-4xl">
        {error ? <p role="alert">{error}</p> : null}
        {lookups ? (
          <LeadForm
            initial={initialValues()}
            lookups={lookups}
            currency={org.currency}
            withPlacement={{ canAssign: can(org.role, 'leads.reassign'), defaultOwnerId: me.id }}
            submitLabel="Add lead"
            onSubmit={async (values) => {
              const lead = await api<LeadDto>(`/v1/orgs/${org.id}/leads`, {
                method: 'POST',
                body: toBody(values),
              });
              router.push(`/app/${org.slug}/leads/${lead.id}`);
            }}
          />
        ) : (
          <p aria-live="polite">Loading</p>
        )}
      </Card>
    </>
  );
}
