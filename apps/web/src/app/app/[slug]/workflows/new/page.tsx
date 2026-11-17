'use client';

import type { WorkflowDto } from '@datoflow/shared';
import { buttonClass } from '@datoflow/ui';
import { ArrowLeft } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { toast } from 'sonner';
import { api, ApiProblem, problemMessage } from '@/lib/api';
import { useLookups } from '@/lib/lookups';
import { useOrg } from '@/lib/org-context';
import { Builder, type FieldErrors } from '../builder';

export default function NewWorkflowPage() {
  const { org } = useOrg();
  const router = useRouter();
  const { lookups, error } = useLookups(org.id);
  const [errors, setErrors] = useState<FieldErrors>([]);
  const [saving, setSaving] = useState(false);
  const base = `/app/${org.slug}/workflows`;

  return (
    <>
      <div className="px-2 pt-4">
        <Link href={base} className={buttonClass('ghost', 'sm', '-ml-3 mb-2')}>
          <ArrowLeft aria-hidden className="size-4" strokeWidth={1.75} />
          Workflows
        </Link>
        <h1 className="display text-heading-lg">New workflow</h1>
        <p className="mt-3 max-w-2xl text-obsidian/80">
          It starts as a draft. Activate it when it is ready
        </p>
      </div>
      {!lookups ? (
        <p aria-live="polite">{error ?? 'Loading'}</p>
      ) : (
        <Builder
          lookups={lookups}
          errors={errors}
          saving={saving}
          submitLabel="Create workflow"
          initial={{
            name: '',
            definition: {
              trigger: 'lead.created',
              conditions: [],
              actions: [
                {
                  type: 'create_task',
                  title: 'Call the new lead',
                  taskType: 'CALL',
                  dueInHours: 4,
                  priority: 'NORMAL',
                  assigneeId: null,
                },
              ],
            },
          }}
          onSubmit={async (value) => {
            setSaving(true);
            setErrors([]);
            try {
              const created = await api<WorkflowDto>(`/v1/orgs/${org.id}/workflows`, {
                method: 'POST',
                body: value,
              });
              toast('Workflow created as a draft');
              router.push(`${base}/${created.id}`);
            } catch (e) {
              if (e instanceof ApiProblem && e.problem.errors) setErrors(e.problem.errors);
              else toast(problemMessage(e));
            } finally {
              setSaving(false);
            }
          }}
        />
      )}
    </>
  );
}
