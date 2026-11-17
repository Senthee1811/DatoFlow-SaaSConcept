'use client';

import { buttonClass, cn } from '@datoflow/ui';
import Link from 'next/link';
import { usePathname } from 'next/navigation';

/** Switches between the workflows and their run log. */
export function WorkflowsNav({ slug }: { slug: string }) {
  const pathname = usePathname();
  const base = `/app/${slug}/workflows`;
  const runs = pathname.startsWith(`${base}/runs`);
  const items = [
    { href: base, label: 'Workflows', active: !runs },
    { href: `${base}/runs`, label: 'Run log', active: runs },
  ];
  return (
    <nav aria-label="Workflows" className="flex gap-1 rounded-pills bg-limestone p-1 self-start">
      {items.map((i) => (
        <Link
          key={i.href}
          href={i.href}
          aria-current={i.active ? 'page' : undefined}
          className={cn(
            buttonClass('ghost', 'sm'),
            i.active && 'bg-obsidian text-chalk hover:bg-obsidian',
          )}
        >
          {i.label}
        </Link>
      ))}
    </nav>
  );
}
