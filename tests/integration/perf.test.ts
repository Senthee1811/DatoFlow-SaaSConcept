import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createOrg, signUp, startApp, type Client, type TestApp } from './harness.js';

let app: TestApp;
let owner: Client;
let orgId: string;
let stageIds: string[];

const LEADS = 10_000;

beforeAll(async () => {
  app = await startApp();
  const user = await signUp(app, 'perf');
  owner = user.client;
  orgId = (await createOrg(owner, 'perf')).id;
  const pipelines = await owner.get(`/v1/orgs/${orgId}/pipelines`);
  stageIds = pipelines.body.items[0].stages.map((s: { id: string }) => s.id);
  // 10,000 leads with a spread of stages, owners, sources, priorities, dates and SLA states.
  await app.sql.query(
    `INSERT INTO "Lead" (id, "organizationId", "pipelineId", "stageId", "ownerId", name, company, email, "emailNormalized",
       "phoneE164", "nameCompanyKey", source, priority, "dealValue", currency, "lastActivityAt", "slaDueAt", "createdAt", "updatedAt")
     SELECT gen_random_uuid(), $1, p.id, (($3::text[])[1 + (g % 4)]), CASE WHEN g % 5 = 0 THEN NULL ELSE $4 END,
       'Lead ' || g, 'Company ' || (g % 700), 'lead' || g || '@example.lk', 'lead' || g || '@example.lk',
       '+9477' || lpad((1000000 + g)::text, 7, '0'), lower('Lead ' || g || '|Company ' || (g % 700)),
       (ARRAY['WEBSITE','FORM','REFERRAL','PAID_SOCIAL','PAID_SEARCH','EMAIL'])[1 + (g % 6)]::"LeadSource",
       (ARRAY['LOW','NORMAL','HIGH'])[1 + (g % 3)]::"Priority",
       (g % 50) * 1000, 'LKR',
       now() - (g % 200) * interval '1 hour', now() + (72 - (g % 200)) * interval '1 hour',
       now() - (g % 365) * interval '1 day', now()
     FROM generate_series(1, $2::int) AS g, "Pipeline" p WHERE p."organizationId" = $1`,
    [orgId, LEADS, stageIds.slice(0, 4), user.userId],
  );
  await app.sql.query('ANALYZE "Lead"');
}, 120_000);
afterAll(() => app.close());

function p95(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.ceil(sorted.length * 0.95) - 1]!;
}

describe('LEAD-05 performance', () => {
  it(`LEAD-05: p95 under 300 ms with ${LEADS.toLocaleString('en')} leads`, async () => {
    const queries = [
      '',
      'limit=100',
      'q=lead 42',
      'q=company 7',
      'q=lead9999@',
      'q=1001234',
      'owner=me',
      'owner=none',
      `stage=${stageIds[1]}`,
      `stage=${stageIds[0]},${stageIds[2]}`,
      'source=PAID_SEARCH,REFERRAL',
      'priority=HIGH',
      'stuck=true',
      'stuck=true&sort=sla_asc',
      'createdFrom=2026-06-01&createdTo=2026-09-30',
      'sort=value_desc',
      'sort=name_asc',
      'status=open&owner=me&priority=HIGH&sort=sla_asc',
    ];
    // Warm up connections and the query planner, then measure three rounds.
    for (const q of queries) await owner.get(`/v1/orgs/${orgId}/leads?${q}`);
    const timings: number[] = [];
    let cursorPages = 0;
    for (let round = 0; round < 3; round++) {
      for (const q of queries) {
        const start = performance.now();
        const res = await owner.get(`/v1/orgs/${orgId}/leads?${q}`);
        timings.push(performance.now() - start);
        expect(res.status, q).toBe(200);
      }
      // A deep page through a cursor.
      let cursor: string | null = null;
      for (let page = 0; page < 5; page++) {
        const start = performance.now();
        const res: { body: { nextCursor: string | null } } = await owner.get(
          `/v1/orgs/${orgId}/leads?limit=100${cursor ? `&cursor=${cursor}` : ''}`,
        );
        timings.push(performance.now() - start);
        cursor = res.body.nextCursor;
        cursorPages++;
      }
    }
    const result = {
      requests: timings.length,
      p95: Math.round(p95(timings)),
      max: Math.round(Math.max(...timings)),
    };
    process.stdout
      .write(`LEAD-05 list latency over ${result.requests} requests: p95 ${result.p95} ms, max ${result.max} ms
`);
    expect(cursorPages).toBe(15);
    expect(result.p95).toBeLessThan(300);
  });
});
