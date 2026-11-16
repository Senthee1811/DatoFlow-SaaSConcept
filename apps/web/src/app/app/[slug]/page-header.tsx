import type { ReactNode } from 'react';

/** Page titles are display type at 48px. Never below 26px. */
export function PageHeader({
  title,
  description,
  actions,
}: {
  title: string;
  description?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-end justify-between gap-4 px-2 pt-4">
      <div>
        <h1 className="display text-heading-lg">{title}</h1>
        {description ? <p className="mt-3 max-w-2xl text-obsidian/80">{description}</p> : null}
      </div>
      {actions}
    </div>
  );
}
