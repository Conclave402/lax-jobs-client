/**
 * Acceptance tests for src/jobs.ts, one per A item in the job text.
 * Run: npm run test:jobs
 */

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { createJobsClient, LaxJobsError } from '../src/jobs.ts';
import type { LaxJobsFetch, LaxJob, LaxSubmission } from '../src/jobs.ts';

interface Call {
  url: string;
  init?: { method?: string; headers?: Record<string, string>; body?: string };
}

function reply(status: number, body: unknown, headers: Record<string, string> = {}) {
  const lowered = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  return {
    status,
    headers: { get: (name: string) => lowered[name.toLowerCase()] ?? null },
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
  };
}

function recorder(handler: (call: Call, n: number) => ReturnType<typeof reply> | Promise<ReturnType<typeof reply>>) {
  const calls: Call[] = [];
  const fetch: LaxJobsFetch = async (url, init) => {
    const call = { url, init };
    calls.push(call);
    return handler(call, calls.length - 1);
  };
  return { calls, fetch };
}

const JOB: LaxJob = {
  id: '96583e5f-4a9b-4ce8-a267-6c166d6188cf',
  title: 'LAX jobs client for @godman-protocols/lax',
  track: 'godman-protocols',
  bounty_usdc: 200,
  status: 'open',
};

const SUBMISSION: LaxSubmission = {
  id: 'sub-1',
  job_id: JOB.id,
  status: 'received',
  created_at: '2026-10-22T19:00:00Z',
};

const VALID = {
  builder: 'pickle-02',
  contact: 'pickle-02@conclave.local',
  repo_or_patch_url: 'https://conclave-q31-audit.surge.sh/lax-jobs-client.git',
  payout_address: '0x2F2E1f54109B2525137EedA4A892600Ee956D42a',
  agent_did: 'did:key:z6Mkp02',
};

test('A1 listJobs, getJob and submit send the documented requests and return the answers', async () => {
  const { calls, fetch } = recorder((call) => {
    if (call.url.endsWith('/jobs?track=godman-protocols&limit=2')) return reply(200, { jobs: [JOB], count: 1 });
    if (call.url.endsWith('/jobs/96583e5f-4a9b-4ce8-a267-6c166d6188cf')) return reply(200, { job: JOB });
    if (call.url.endsWith('/jobs/96583e5f-4a9b-4ce8-a267-6c166d6188cf/submissions')) {
      return reply(200, { submission: SUBMISSION });
    }
    return reply(500, { message: 'unexpected url' });
  });
  const client = createJobsClient({ fetch, sleep: async () => {} });

  const listed = await client.listJobs({ track: 'godman-protocols', limit: 2 });
  assert.deepEqual(listed, { jobs: [JOB], count: 1 });
  assert.equal(calls[0]?.init?.method, 'GET');
  assert.equal(calls[0]?.init?.body, undefined);

  const one = await client.getJob(JOB.id);
  assert.deepEqual(one, JOB);

  const sent = await client.submit(JOB.id, { ...VALID, notes: 'M1 in this commit' });
  assert.deepEqual(sent, SUBMISSION);
  assert.equal(calls[2]?.init?.method, 'POST');
  assert.equal(calls[2]?.init?.headers?.['content-type'], 'application/json');
  assert.deepEqual(JSON.parse(calls[2]?.init?.body ?? '{}'), { ...VALID, notes: 'M1 in this commit' });
});

test('A2 400, 404 and 409 throw LaxJobsError with the status, code and message after one request', async () => {
  for (const [status, code, message] of [
    [400, 'bad_request', 'bad job body'],
    [404, 'not_found', 'no such job'],
    [409, 'conflict', 'submission already exists'],
  ] as const) {
    const { calls, fetch } = recorder(() => reply(status, { message }));
    const client = createJobsClient({ fetch, sleep: async () => {} });
    await assert.rejects(
      () => client.getJob(JOB.id),
      (error: unknown) =>
        error instanceof LaxJobsError &&
        error.status === status &&
        error.code === code &&
        error.message === message,
    );
    assert.equal(calls.length, 1);
  }
});

test('A3 429 honours Retry-After and then succeeds; when it never ends the last retry throws rate_limited', async () => {
  const slept: number[] = [];
  const once = recorder((_call, n) =>
    n === 0 ? reply(429, { message: 'slow down' }, { 'Retry-After': '2' }) : reply(200, { jobs: [], count: 0 }),
  );
  const client = createJobsClient({ fetch: once.fetch, sleep: async (ms) => { slept.push(ms); } });
  assert.deepEqual(await client.listJobs(), { jobs: [], count: 0 });
  assert.deepEqual(slept, [2000]);

  const always = recorder(() => reply(429, { message: 'still slow' }, { 'Retry-After': '1' }));
  const sleptAgain: number[] = [];
  const limited = createJobsClient({ fetch: always.fetch, retries: 1, sleep: async (ms) => { sleptAgain.push(ms); } });
  await assert.rejects(
    () => limited.getJob(JOB.id),
    (error: unknown) => error instanceof LaxJobsError && error.status === 429 && error.code === 'rate_limited',
  );
  assert.equal(always.calls.length, 2);
  assert.deepEqual(sleptAgain, [1000]);
});

test('A4 reads retry 5xx and network errors, submit retries neither', async () => {
  const slept: number[] = [];
  const flaky = recorder((_call, n) => (n < 2 ? reply(503, { message: 'warming up' }) : reply(200, { job: JOB })));
  const client = createJobsClient({ fetch: flaky.fetch, sleep: async (ms) => { slept.push(ms); } });
  assert.deepEqual(await client.getJob(JOB.id), JOB);
  assert.deepEqual(slept, [500, 1000]);

  const down = recorder(() => reply(502, { message: 'bad gateway' }));
  const readDown = createJobsClient({ fetch: down.fetch, sleep: async () => {} });
  await assert.rejects(
    () => readDown.listJobs(),
    (error: unknown) => error instanceof LaxJobsError && error.status === 502 && error.code === 'server',
  );
  assert.equal(down.calls.length, 3);

  const offline = recorder(() => { throw new Error('getaddrinfo ENOTFOUND lax.kognai.ai'); });
  const readOffline = createJobsClient({ fetch: offline.fetch, sleep: async () => {} });
  await assert.rejects(
    () => readOffline.getJob(JOB.id),
    (error: unknown) => error instanceof LaxJobsError && error.status === 0 && error.code === 'network',
  );
  assert.equal(offline.calls.length, 3);

  const submitDown = recorder(() => reply(500, { message: 'server error' }));
  const posting = createJobsClient({ fetch: submitDown.fetch, sleep: async () => {} });
  await assert.rejects(
    () => posting.submit(JOB.id, VALID),
    (error: unknown) => error instanceof LaxJobsError && error.status === 500 && error.code === 'server',
  );
  assert.equal(submitDown.calls.length, 1);

  const submitOffline = recorder(() => { throw new Error('socket hang up'); });
  const postingOffline = createJobsClient({ fetch: submitOffline.fetch, sleep: async () => {} });
  await assert.rejects(
    () => postingOffline.submit(JOB.id, VALID),
    (error: unknown) => error instanceof LaxJobsError && error.status === 0 && error.code === 'network',
  );
  assert.equal(submitOffline.calls.length, 1);
});

test('A5 submit refuses a missing DID, a bad payout address and a non-https link before any request', async () => {
  const { calls, fetch } = recorder(() => reply(200, { submission: SUBMISSION }));
  const client = createJobsClient({ fetch, sleep: async () => {} });
  const cases = [
    { ...VALID, agent_did: '' },
    { ...VALID, agent_did: 'pickle-02' },
    { ...VALID, payout_address: '0x1234' },
    { ...VALID, payout_address: '2F2E1f54109B2525137EedA4A892600Ee956D42a' },
    { ...VALID, repo_or_patch_url: 'http://example.com/repo.git' },
    { ...VALID, repo_or_patch_url: 'git@example.com:repo.git' },
  ];
  for (const input of cases) {
    await assert.rejects(
      () => client.submit(JOB.id, input),
      (error: unknown) => error instanceof LaxJobsError && error.status === 0 && error.code === 'invalid_input',
    );
  }
  assert.equal(calls.length, 0);
});

test('A6 the client adds no runtime dependency and writes nothing to the console', async () => {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
    dependencies?: Record<string, string>;
  };
  assert.deepEqual(pkg.dependencies ?? {}, {});
  const source = readFileSync(new URL('../src/jobs.ts', import.meta.url), 'utf8');
  assert.equal(/console\s*\./.test(source), false);
  const entry = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8');
  assert.match(entry, /export \{ createJobsClient, LaxJobsError \} from '\.\/jobs\.js';/);
});

test('A7 the live registry answers GET /jobs when LAX_LIVE=1', { skip: process.env.LAX_LIVE !== '1' }, async () => {
  const client = createJobsClient({ timeoutMs: 30_000 });
  const answer = await client.listJobs({ limit: 3 });
  assert.equal(Array.isArray(answer.jobs), true);
  assert.equal(typeof answer.count, 'number');
  assert.equal(answer.jobs.length <= 3, true);
});
