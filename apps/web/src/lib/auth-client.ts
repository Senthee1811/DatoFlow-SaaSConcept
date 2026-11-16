'use client';

import { organizationClient } from 'better-auth/client/plugins';
import { createAuthClient } from 'better-auth/react';

/** Talks to Better Auth through the same-origin /v1 proxy. */
export const authClient = createAuthClient({
  basePath: '/v1/auth',
  plugins: [organizationClient()],
});
