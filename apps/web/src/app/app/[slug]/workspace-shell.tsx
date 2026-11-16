'use client';

import { can, ROLE_LABEL, type Capability } from '@datoflow/domain';
import type { OrgDto } from '@datoflow/shared';
import { buttonClass, cn, Logo, Select } from '@datoflow/ui';
import { Menu } from 'lucide-react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { api, ApiProblem, problemMessage } from '@/lib/api';
import { authClient } from '@/lib/auth-client';
import { OrgContext, type Me, type OrgContextValue } from '@/lib/org-context';

interface NavItem {
  href: string;
  label: string;
  capability?: Capability;
}

const NAV: NavItem[] = [
  { href: '', label: 'Overview' },
  { href: '/members', label: 'Members', capability: 'members.manage' },
  { href: '/audit', label: 'Audit log', capability: 'audit.view' },
  { href: '/settings', label: 'Settings', capability: 'org.settings' },
];

export function WorkspaceShell({ slug, children }: { slug: string; children: ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const [state, setState] = useState<{ me: Me; orgs: OrgDto[] } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [me, orgs] = await Promise.all([
        api<Me>('/v1/me'),
        api<{ items: OrgDto[] }>('/v1/orgs'),
      ]);
      setState({ me, orgs: orgs.items });
    } catch (e) {
      if (e instanceof ApiProblem && e.status === 401)
        router.replace(`/sign-in?next=${encodeURIComponent(pathname)}`);
      else setError(problemMessage(e));
    }
  }, [router, pathname]);

  useEffect(() => {
    void load();
  }, [load]);

  const org = state?.orgs.find((o) => o.slug === slug);

  // Opening a workspace by its address makes it the active one on this session (ORG-02).
  useEffect(() => {
    if (org && state && state.me.activeOrganizationId !== org.id) {
      void authClient.organization.setActive({ organizationId: org.id });
    }
  }, [org, state]);

  if (error) return <CenteredMessage>{error}</CenteredMessage>;
  if (!state) return <CenteredMessage>Loading your workspace</CenteredMessage>;
  if (!org) {
    return (
      <CenteredMessage>
        <span className="display mb-4 block text-heading-lg">Workspace not found</span>
        You are not a member of a workspace at this address.{' '}
        <Link href="/app" className="underline decoration-dotted underline-offset-4">
          Open your workspace
        </Link>
      </CenteredMessage>
    );
  }

  const base = `/app/${org.slug}`;
  const items = NAV.filter((i) => !i.capability || can(org.role, i.capability));
  const isActive = (href: string) =>
    href === '' ? pathname === base : pathname.startsWith(base + href);
  const value: OrgContextValue = { me: state.me, org, orgs: state.orgs, reload: load };

  const links = (vertical: boolean) =>
    items.map((item) => (
      <Link
        key={item.href}
        href={base + item.href}
        aria-current={isActive(item.href) ? 'page' : undefined}
        className={cn(
          buttonClass('ghost', 'sm', 'min-h-11'),
          vertical && 'justify-start',
          isActive(item.href) && 'bg-obsidian text-chalk hover:bg-obsidian',
        )}
      >
        {item.label}
      </Link>
    ));

  return (
    <OrgContext.Provider value={value}>
      <div className="mx-auto flex min-h-dvh max-w-page flex-col gap-6 p-4 lg:p-6">
        <header className="flex items-center gap-2 rounded-pills bg-limestone py-2 pr-2 pl-5">
          <Link
            href={base}
            className="mr-2 rounded-pills"
            aria-label={`DatoFlow, ${org.name} overview`}
          >
            <Logo />
          </Link>
          <nav aria-label="Workspace" className="hidden flex-1 items-center gap-1 md:flex">
            {links(false)}
          </nav>
          <div className="ml-auto flex items-center gap-2">
            <label className="sr-only" htmlFor="workspace-switcher">
              Workspace
            </label>
            <div className="hidden w-56 sm:block">
              <Select
                id="workspace-switcher"
                value={org.slug}
                className="min-h-11"
                onChange={async (e) => {
                  const next = state.orgs.find((o) => o.slug === e.target.value);
                  if (!next) return;
                  await authClient.organization.setActive({ organizationId: next.id });
                  router.push(`/app/${next.slug}`);
                }}
              >
                {state.orgs.map((o) => (
                  <option key={o.id} value={o.slug}>
                    {o.name}
                  </option>
                ))}
              </Select>
            </div>
            <Link
              href={`${base}/account`}
              aria-current={pathname === `${base}/account` ? 'page' : undefined}
              className={buttonClass('ghost', 'sm', 'hidden md:inline-flex')}
            >
              {state.me.name}
            </Link>
            <details className="relative md:hidden">
              <summary
                className={buttonClass(
                  'ghost',
                  'sm',
                  'list-none [&::-webkit-details-marker]:hidden',
                )}
              >
                <Menu aria-hidden className="size-4" strokeWidth={1.75} />
                Menu
              </summary>
              <div className="absolute right-0 z-10 mt-2 flex w-64 flex-col gap-1 rounded-medium bg-limestone p-2">
                {links(true)}
                <Link
                  href={`${base}/account`}
                  className={buttonClass('ghost', 'sm', 'justify-start')}
                >
                  Account
                </Link>
                <Link href="/app/new" className={buttonClass('ghost', 'sm', 'justify-start')}>
                  New workspace
                </Link>
              </div>
            </details>
          </div>
        </header>

        <main className="flex flex-1 flex-col gap-6 pb-12">{children}</main>

        <footer className="caption flex flex-wrap items-center gap-x-4 gap-y-2 px-5 pb-2 text-obsidian/75">
          <span>
            {org.name} · {ROLE_LABEL[org.role]}
          </span>
          <Link href="/app/new" className="underline decoration-dotted underline-offset-4">
            New workspace
          </Link>
        </footer>
      </div>
    </OrgContext.Provider>
  );
}

function CenteredMessage({ children }: { children: ReactNode }) {
  return (
    <main className="grid min-h-dvh place-items-center p-6">
      <p aria-live="polite" className="max-w-md text-center">
        {children}
      </p>
    </main>
  );
}
