/**
 * LAX jobs client: list jobs, read one job and submit work.
 *
 * fetch only, no runtime dependency, and every failure is a LaxJobsError with
 * the HTTP status, a stable code and the registry's own error text.
 */

const DEFAULT_BASE_URL = 'https://lax.kognai.ai/registry';

/** Stable failure codes: network and invalid_response cover status 0. */
export type LaxJobsErrorCode =
  | 'invalid_input'
  | 'bad_request'
  | 'not_found'
  | 'conflict'
  | 'rate_limited'
  | 'server'
  | 'network'
  | 'invalid_response';

export class LaxJobsError extends Error {
  readonly status: number;
  readonly code: LaxJobsErrorCode;

  constructor(message: string, status: number, code: LaxJobsErrorCode) {
    super(message);
    this.name = 'LaxJobsError';
    this.status = status;
    this.code = code;
  }
}

/** One open job, as the registry returns it. */
export interface LaxJob {
  id: string;
  title: string;
  track: string;
  summary?: string | null;
  spec_md?: string | null;
  spec_url?: string | null;
  tests_url?: string | null;
  skills?: string[];
  bounty_usdc?: number;
  currency?: string;
  chain?: string;
  deadline?: string;
  status?: string;
  seat?: string | null;
  created_at?: string;
  updated_at?: string | null;
  bid_closes?: string | null;
  selection?: unknown;
  [key: string]: unknown;
}

/** The submission the registry stored. */
export interface LaxSubmission {
  id: string;
  job_id: string;
  status: string;
  created_at: string;
  [key: string]: unknown;
}

export interface LaxSubmissionInput {
  builder: string;
  contact: string;
  repo_or_patch_url: string;
  payout_address: string;
  agent_did: string;
  notes?: string;
}

export interface LaxJobsListParams {
  track?: string;
  limit?: number;
  offset?: number;
}

export interface LaxJobsList {
  jobs: LaxJob[];
  count: number;
}

/** Minimal response surface, so a test can pass any fetch shaped like the global one. */
export interface LaxJobsResponse {
  status: number;
  headers?: { get(name: string): string | null };
  text(): Promise<string>;
}

export type LaxJobsFetch = (
  url: string,
  init?: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
  },
) => Promise<LaxJobsResponse>;

export interface LaxJobsClientOptions {
  baseUrl?: string;
  fetch?: LaxJobsFetch;
  /** Extra attempts after the first, default 2. */
  retries?: number;
  sleep?: (ms: number) => Promise<unknown>;
  timeoutMs?: number;
}

export interface LaxJobsClient {
  listJobs(params?: LaxJobsListParams): Promise<LaxJobsList>;
  getJob(id: string): Promise<LaxJob>;
  submit(jobId: string, input: LaxSubmissionInput): Promise<LaxSubmission>;
}

const DID = /^did:[a-z0-9]+:[^\s]+$/;
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const HTTPS_URL = /^https:\/\/[^\s]+$/;
const MAX_RETRY_AFTER_MS = 30_000;

function invalidInput(message: string): LaxJobsError {
  return new LaxJobsError(message, 0, 'invalid_input');
}

function codeFor(status: number): LaxJobsErrorCode {
  if (status === 400) return 'bad_request';
  if (status === 404) return 'not_found';
  if (status === 409) return 'conflict';
  if (status === 429) return 'rate_limited';
  if (status >= 500) return 'server';
  return 'bad_request';
}

function headerValue(res: LaxJobsResponse, name: string): string | null {
  if (!res.headers) return null;
  if (typeof res.headers.get === 'function') return res.headers.get(name);
  return null;
}

function errorText(text: string, status: number): string {
  const trimmed = text.trim();
  if (trimmed) {
    try {
      const body = JSON.parse(trimmed) as Record<string, unknown>;
      for (const key of ['message', 'error', 'detail']) {
        const value = body[key];
        if (typeof value === 'string' && value.trim()) return value.trim().slice(0, 500);
      }
    } catch {
      return trimmed.slice(0, 500);
    }
    return trimmed.slice(0, 500);
  }
  return `HTTP ${status}`;
}

function retryDelay(res: LaxJobsResponse, attempt: number): number {
  const raw = headerValue(res, 'retry-after');
  if (raw) {
    if (/^\d+(\.\d+)?$/.test(raw.trim())) {
      return Math.min(MAX_RETRY_AFTER_MS, Number(raw.trim()) * 1000);
    }
    const date = Date.parse(raw);
    if (!Number.isNaN(date)) {
      return Math.min(MAX_RETRY_AFTER_MS, Math.max(0, date - Date.now()));
    }
  }
  return 500 * 2 ** attempt;
}

function withTimeout<T>(work: Promise<T>, timeoutMs: number): Promise<T> {
  if (!timeoutMs || !Number.isFinite(timeoutMs)) return work;
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`request timed out after ${timeoutMs} ms`)), timeoutMs);
    (timer as unknown as { unref?: () => void }).unref?.();
    work.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

function parseBody(text: string, status: number): Record<string, unknown> {
  try {
    const body = JSON.parse(text) as unknown;
    if (!body || typeof body !== 'object') throw new Error('not an object');
    return body as Record<string, unknown>;
  } catch {
    throw new LaxJobsError('registry returned invalid JSON', status, 'invalid_response');
  }
}

/**
 * Create a jobs client. Every option is optional; the defaults target the
 * public registry and the global fetch.
 */
export function createJobsClient(options: LaxJobsClientOptions = {}): LaxJobsClient {
  const baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
  const retries = options.retries ?? 2;
  const timeoutMs = options.timeoutMs ?? 15_000;
  const sleep = options.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
  const doFetch: LaxJobsFetch =
    options.fetch ?? (globalThis as unknown as { fetch: LaxJobsFetch }).fetch;

  async function request(
    method: 'GET' | 'POST',
    path: string,
    mode: 'read' | 'submit',
    payload?: { body: string },
  ): Promise<string> {
    const init = payload
      ? { method, headers: { 'content-type': 'application/json' }, body: payload.body }
      : { method };

    for (let attempt = 0; ; attempt += 1) {
      let res: LaxJobsResponse;
      try {
        res = await withTimeout(doFetch(baseUrl + path, init), timeoutMs);
      } catch (error) {
        if (mode === 'read' && attempt < retries) {
          await sleep(500 * 2 ** attempt);
          continue;
        }
        const message = error instanceof Error ? error.message : String(error);
        throw new LaxJobsError(message, 0, 'network');
      }

      const text = await res.text();

      if (res.status >= 200 && res.status < 300) return text;

      const code = codeFor(res.status);
      const retryable = res.status === 429 || (mode === 'read' && res.status >= 500);
      if (retryable && attempt < retries) {
        await sleep(res.status === 429 ? retryDelay(res, attempt) : 500 * 2 ** attempt);
        continue;
      }
      throw new LaxJobsError(errorText(text, res.status), res.status, code);
    }
  }

  return {
    async listJobs(params: LaxJobsListParams = {}): Promise<LaxJobsList> {
      const query: string[] = [];
      if (params.track !== undefined) query.push(`track=${encodeURIComponent(params.track)}`);
      if (params.limit !== undefined) query.push(`limit=${params.limit}`);
      if (params.offset !== undefined) query.push(`offset=${params.offset}`);
      const suffix = query.length ? `?${query.join('&')}` : '';
      const text = await request('GET', `/jobs${suffix}`, 'read');
      const body = parseBody(text, 200);
      if (!Array.isArray(body.jobs) || typeof body.count !== 'number') {
        throw new LaxJobsError('registry returned an unexpected jobs answer', 200, 'invalid_response');
      }
      return { jobs: body.jobs as LaxJob[], count: body.count };
    },

    async getJob(id: string): Promise<LaxJob> {
      const text = await request('GET', `/jobs/${encodeURIComponent(id)}`, 'read');
      const body = parseBody(text, 200);
      if (!body.job || typeof body.job !== 'object') {
        throw new LaxJobsError('registry returned an unexpected job answer', 200, 'invalid_response');
      }
      return body.job as LaxJob;
    },

    async submit(jobId: string, input: LaxSubmissionInput): Promise<LaxSubmission> {
      if (!input || typeof input.agent_did !== 'string' || !DID.test(input.agent_did)) {
        throw invalidInput('agent_did must be a DID (did:method:identifier)');
      }
      if (typeof input.payout_address !== 'string' || !ADDRESS.test(input.payout_address)) {
        throw invalidInput('payout_address must be 0x followed by 40 hex characters');
      }
      if (typeof input.repo_or_patch_url !== 'string' || !HTTPS_URL.test(input.repo_or_patch_url)) {
        throw invalidInput('repo_or_patch_url must be an https link');
      }

      const body: Record<string, string> = {
        builder: input.builder,
        contact: input.contact,
        repo_or_patch_url: input.repo_or_patch_url,
        payout_address: input.payout_address,
        agent_did: input.agent_did,
      };
      if (input.notes !== undefined) body.notes = input.notes;

      const text = await request('POST', `/jobs/${encodeURIComponent(jobId)}/submissions`, 'submit', {
        body: JSON.stringify(body),
      });
      const parsed = parseBody(text, 200);
      if (!parsed.submission || typeof parsed.submission !== 'object') {
        throw new LaxJobsError('registry returned an unexpected submission answer', 200, 'invalid_response');
      }
      return parsed.submission as LaxSubmission;
    },
  };
}
