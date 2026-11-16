'use client';

import type { OrgDto } from '@datoflow/shared';
import { createContext, useContext } from 'react';

export interface Me {
  id: string;
  name: string;
  email: string;
  emailVerified: boolean;
  activeOrganizationId: string | null;
}

export interface OrgContextValue {
  me: Me;
  org: OrgDto;
  orgs: OrgDto[];
  reload(): Promise<void>;
}

export const OrgContext = createContext<OrgContextValue | null>(null);

export function useOrg(): OrgContextValue {
  const value = useContext(OrgContext);
  if (!value) throw new Error('useOrg is only available inside a workspace');
  return value;
}

/** Formats an instant in the organization's timezone. Times are stored in UTC. */
export function formatInOrgTime(
  iso: string,
  timezone: string,
  options?: Intl.DateTimeFormatOptions,
) {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: timezone,
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    ...options,
  }).format(new Date(iso));
}
