import { defineConfig } from 'prisma/config';

// `prisma generate` runs without a database, so the URL falls back to a placeholder
// instead of throwing. Migrate commands still fail clearly when it is missing.
export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: { path: 'prisma/migrations' },
  datasource: {
    url: process.env.DATABASE_URL ?? 'postgresql://unset:unset@localhost:5432/unset',
  },
});
