import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { GenericContainer, type StartedTestContainer, Wait } from 'testcontainers';
import type { TestProject } from 'vitest/node';

declare module 'vitest' {
  export interface ProvidedContext {
    databaseUrl: string;
    redisUrl: string;
  }
}

let containers: StartedTestContainer[] = [];

/** Starts Postgres and Redis once for the whole integration run and applies the checked-in migrations. */
export default async function setup(project: TestProject) {
  const [pg, redis] = await Promise.all([
    new GenericContainer('postgres:17-alpine')
      .withEnvironment({
        POSTGRES_USER: 'datoflow',
        POSTGRES_PASSWORD: 'datoflow',
        POSTGRES_DB: 'datoflow',
      })
      .withExposedPorts(5432)
      .withWaitStrategy(Wait.forLogMessage('database system is ready to accept connections', 2))
      .start(),
    new GenericContainer('redis:7.4-alpine').withExposedPorts(6379).start(),
  ]);
  containers = [pg, redis];

  const databaseUrl = `postgresql://datoflow:datoflow@${pg.getHost()}:${pg.getMappedPort(5432)}/datoflow`;
  const redisUrl = `redis://${redis.getHost()}:${redis.getMappedPort(6379)}`;

  execFileSync('pnpm', ['exec', 'prisma', 'migrate', 'deploy'], {
    cwd: join(import.meta.dirname, '..', '..', 'packages', 'db'),
    env: { ...process.env, DATABASE_URL: databaseUrl },
    stdio: 'pipe',
    shell: process.platform === 'win32',
  });

  project.provide('databaseUrl', databaseUrl);
  project.provide('redisUrl', redisUrl);

  return async () => {
    await Promise.all(containers.map((c) => c.stop()));
  };
}
