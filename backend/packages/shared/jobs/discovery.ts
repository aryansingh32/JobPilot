import { gunzipSync } from 'zlib';
import { getPgPool } from '../db/index.js';
import { createLogger } from '../logger/index.js';
import type { AtsType } from './sources.js';

// ============================================================
// BOARD DISCOVERY — grows the registry toward every company that hires
// through a system we can read. Every source only adds *candidates*; the
// poller checks each one once and marks it active / empty / dead.
//
//   dataset      MIT-licensed open list of Greenhouse/Lever/Ashby/Workday
//                boards (Feashliaa/job-board-aggregator, pinned commit).
//   commoncrawl  Common Crawl's public URL index, read straight from
//                data.commoncrawl.org with HTTP range requests (no query
//                server): every host/path on a system's domain → a board.
//   seed         boards verified by hand (Indian corporates on
//                SuccessFactors, Oracle tenants…).
//   link         job links users paste (added as they apply).
// ============================================================

const logger = createLogger('board-discovery');
const UA = 'jobpilot-discovery/1.0 (+https://jobpilot.app)';

export type DiscoverySource = 'dataset' | 'commoncrawl' | 'seed' | 'link';

/** Insert boards that aren't registered yet as candidates. Returns how many were new. */
/** Queue a discovery run on a worker (survives admin/scheduler restarts). */
export async function enqueueDiscovery(payload: { source: 'dataset' | 'commoncrawl' | 'seed'; crawls?: string[]; systems?: string[]; maxBlocks?: number }) {
  const { enqueueJob } = await import('../queue/index.js');
  return enqueueJob({
    id: `discover-${payload.source}-${Date.now()}`,
    type: 'jobs-discover',
    priority: 'low',
    createdAt: new Date(),
    userId: 'scheduler',
    payload,
  } as import('../types/index.js').DiscoverBoardsJob);
}

/** Run one discovery job (worker side). */
export async function runDiscovery(p: { source: string; crawls?: string[]; systems?: string[]; maxBlocks?: number }) {
  if (p.source === 'dataset') return discoverFromDataset();
  if (p.source === 'seed') return discoverFromSeeds();
  return discoverFromCommonCrawl({ crawls: p.crawls, systems: p.systems as AtsType[] | undefined, maxBlocks: p.maxBlocks });
}

export async function addCandidates(atsType: AtsType, tokens: string[], via: string): Promise<number> {
  // A link's query string or fragment is never part of a board ("lithia/wd5/careers?q=l0377" is the board "lithia/wd5/careers").
  const clean = [...new Set(tokens.map((t) => t.trim().split(/[?#]/)[0].replace(/\/+$/, '')).filter((t) => t && t.length <= 300 && !/[&=\s]/.test(t)))];
  let added = 0;
  for (let i = 0; i < clean.length; i += 1000) {
    const { rowCount } = await getPgPool().query(
      `INSERT INTO job_boards (ats_type, board_token, status, discovered_via, next_poll_at)
       SELECT $1, t, 'candidate', $3, NULL FROM unnest($2::text[]) AS t
       ON CONFLICT (ats_type, board_token) DO NOTHING`,
      [atsType, clean.slice(i, i + 1000), via],
    );
    added += rowCount ?? 0;
  }
  return added;
}

async function track<T extends { found: number; added: number }>(source: DiscoverySource, params: unknown, fn: () => Promise<T>) {
  const pool = getPgPool();
  // Runs a restart cut off never finish on their own.
  await pool.query(
    `UPDATE board_discovery_runs SET status = 'failed', error = 'interrupted', finished_at = NOW()
      WHERE status = 'running' AND started_at < NOW() - INTERVAL '3 hours'`,
  );
  const { rows } = await pool.query('INSERT INTO board_discovery_runs (source, params) VALUES ($1, $2) RETURNING id', [source, JSON.stringify(params ?? {})]);
  const runId = rows[0].id as string;
  try {
    const r = await fn();
    await pool.query(`UPDATE board_discovery_runs SET status = 'done', found = $2, added = $3, finished_at = NOW() WHERE id = $1`, [runId, r.found, r.added]);
    logger.info('discovery:done', { source, ...r });
    return { runId, ...r };
  } catch (err) {
    await pool.query(`UPDATE board_discovery_runs SET status = 'failed', error = $2, finished_at = NOW() WHERE id = $1`, [runId, (err as Error).message.slice(0, 500)]);
    logger.error('discovery:failed', err, { source });
    throw err;
  }
}

// ─── Open dataset (MIT) ───────────────────────────────────────
// https://github.com/Feashliaa/job-board-aggregator — MIT License,
// Copyright (c) 2026 Riley Dorrington. Pinned so imports are reproducible.
const DATASET_REPO = 'Feashliaa/job-board-aggregator';
const DATASET_COMMIT = '01337d25f20a043de6c26db7a350e36aa544457f';
const DATASET_FILES: Partial<Record<AtsType, string>> = {
  greenhouse: 'data/greenhouse_companies.json',
  lever: 'data/lever_companies.json',
  ashby: 'data/ashby_companies.json',
  workday: 'data/workday_companies.json',
};

export function discoverFromDataset(commit = DATASET_COMMIT) {
  return track('dataset', { repo: DATASET_REPO, commit }, async () => {
    let found = 0;
    let added = 0;
    for (const [ats, path] of Object.entries(DATASET_FILES) as [AtsType, string][]) {
      const res = await fetch(`https://raw.githubusercontent.com/${DATASET_REPO}/${commit}/${path}`, {
        headers: { 'user-agent': UA },
        signal: AbortSignal.timeout(60_000),
      });
      if (!res.ok) throw new Error(`${path}: HTTP ${res.status}`);
      const list = (await res.json()) as string[];
      // Workday entries are "tenant|wd1|site"; we store "tenant/wd1/site".
      const tokens = list.map((t) => (ats === 'workday' ? t.split('|').join('/') : t)).filter((t) => (ats === 'workday' ? t.split('/').length === 3 : true));
      found += tokens.length;
      added += await addCandidates(ats, tokens, 'dataset');
    }
    return { found, added };
  });
}

// ─── Common Crawl (raw index over HTTP ranges) ───────────────
// The index is a sorted list of URL keys (SURT: "com,keka,acme)/careers").
// cluster.idx (~100 MB) maps the first key of every block to a byte range,
// so a prefix is found by binary search with small range requests and only
// its blocks (~270 KB compressed each) are downloaded.

const CC = 'https://data.commoncrawl.org/cc-index/collections';

async function range(url: string, from: number, to: number): Promise<Buffer> {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url, { headers: { Range: `bytes=${from}-${to}`, 'user-agent': UA }, signal: AbortSignal.timeout(60_000) });
    if (res.ok) return Buffer.from(await res.arrayBuffer());
    if (attempt >= 3 || (res.status !== 503 && res.status !== 429)) throw new Error(`Common Crawl ${res.status} for ${url}`);
    await new Promise((r) => setTimeout(r, 2000 * 2 ** attempt));
  }
}

async function clusterSize(crawl: string): Promise<number> {
  const res = await fetch(`${CC}/${crawl}/indexes/cluster.idx`, { method: 'HEAD', headers: { 'user-agent': UA }, signal: AbortSignal.timeout(30_000) });
  const n = Number(res.headers.get('content-length'));
  if (!res.ok || !n) throw new Error(`Common Crawl index ${crawl} not available (${res.status})`);
  return n;
}

/** Blocks (shard, offset, length) whose keys may start with `prefix`. */
async function blocksFor(crawl: string, prefix: string, maxBlocks: number) {
  const idx = `${CC}/${crawl}/indexes/cluster.idx`;
  const size = await clusterSize(crawl);
  const keyAt = async (off: number) => {
    const text = (await range(idx, off, off + 4096)).toString('utf8');
    return (off ? text.split('\n')[1] : text.split('\n')[0]).split(' ')[0];
  };
  let lo = 0;
  let hi = size;
  while (hi - lo > 4096) {
    const mid = Math.floor((lo + hi) / 2);
    if ((await keyAt(mid)) < prefix) lo = mid;
    else hi = mid;
  }
  const out: { key: string; shard: string; offset: number; length: number }[] = [];
  let off = lo;
  // Read cluster.idx forward until past the prefix.
  for (let page = 0; page < 20; page++) {
    const lines = (await range(idx, off, off + 400_000)).toString('utf8').split('\n');
    if (off) lines.shift();
    lines.pop();
    for (const l of lines) {
      const p = l.split('\t');
      if (p.length < 4) continue;
      out.push({ key: p[0].split(' ')[0], shard: p[1], offset: Number(p[2]), length: Number(p[3]) });
    }
    off += 400_000;
    if (!out.length || out[out.length - 1].key > `${prefix}~`) break;
  }
  const keep = out.filter((b, i) => (out[i + 1]?.key ?? '~') >= prefix && b.key <= `${prefix}~`);
  return keep.slice(0, maxBlocks);
}

/** Every index line (SURT key) starting with `prefix`. */
export async function* ccKeys(crawl: string, prefix: string, maxBlocks = 300): AsyncGenerator<string> {
  for (const b of await blocksFor(crawl, prefix, maxBlocks)) {
    const raw = await range(`${CC}/${crawl}/indexes/${b.shard}`, b.offset, b.offset + b.length - 1);
    for (const line of gunzipSync(raw).toString('utf8').split('\n')) {
      if (line.startsWith(prefix)) yield line.split(' ')[0];
    }
  }
}

const SKIP_SUB = new Set(['www', 'help', 'api', 'static', 'cdn', 'app', 'm', 'blog', 'mail', 'status', 'developer', 'developers', 'docs', 'support', 'login']);

/** How each system's URL keys turn into board tokens. */
const CC_RULES: { ats: AtsType; prefixes: string[]; token: (host: string, path: string) => string | null }[] = [
  { ats: 'keka', prefixes: ['com,keka,'], token: (h, p) => (h.endsWith('.keka.com') && p.startsWith('/careers') ? sub(h, 'keka.com') : null) },
  {
    ats: 'zoho',
    prefixes: ['in,zohorecruit,', 'com,zohorecruit,', 'eu,zohorecruit,', 'com.au,zohorecruit,'],
    token: (h, p) => (/\.zohorecruit\.[a-z.]+$/.test(h) && p.startsWith('/jobs') && h.split('.').length >= 3 && !SKIP_SUB.has(h.split('.')[0]) ? h : null),
  },
  { ats: 'freshteam', prefixes: ['com,freshteam,'], token: (h, p) => (p.startsWith('/jobs') ? sub(h, 'freshteam.com') : null) },
  { ats: 'greenhouse', prefixes: ['io,greenhouse,boards)/', 'io,greenhouse,job-boards)/'], token: (_h, p) => firstSeg(p) },
  { ats: 'lever', prefixes: ['co,lever,jobs)/'], token: (_h, p) => firstSeg(p) },
  { ats: 'workable', prefixes: ['com,workable,apply)/'], token: (_h, p) => firstSeg(p) },
  { ats: 'recruitee', prefixes: ['com,recruitee,'], token: (h) => (h.endsWith('.recruitee.com') && !SKIP_SUB.has(h.split('.')[0]) ? sub(h, 'recruitee.com') : null) },
  { ats: 'breezy', prefixes: ['hr,breezy,'], token: (h, p) => (h.endsWith('.breezy.hr') && p.startsWith('/p/') && !SKIP_SUB.has(h.split('.')[0]) ? sub(h, 'breezy.hr') : null) },
  { ats: 'personio', prefixes: ['de,personio,jobs,', 'com,personio,jobs,'], token: (h) => (/\.jobs\.personio\.(de|com)$/.test(h) ? h.split('.')[0] : null) },
  { ats: 'ashby', prefixes: ['com,ashbyhq,jobs)/'], token: (_h, p) => firstSeg(p) },
  { ats: 'smartrecruiters', prefixes: ['com,smartrecruiters,jobs)/'], token: (_h, p) => firstSeg(p) },
  {
    ats: 'workday',
    prefixes: ['com,myworkdayjobs,'],
    token: (h, p) => {
      const m = h.match(/^([a-z0-9-]+)\.(wd\d+)\.myworkdayjobs\.com$/);
      const segs = p.split('/').filter(Boolean);
      const site = /^[a-z]{2}-[a-z]{2}$/i.test(segs[0] ?? '') ? segs[1] : segs[0];
      return m && site && !/^(wday|robots\.txt)$/i.test(site) ? `${m[1]}/${m[2]}/${site}` : null;
    },
  },
  {
    ats: 'oracle',
    prefixes: ['com,oraclecloud,'],
    token: (h, p) => {
      const m = p.match(/\/hcmui\/candidateexperience\/[a-z-]+\/sites\/([a-z0-9_]+)/i);
      return m ? `${h}|${m[1].toUpperCase()}` : null;
    },
  },
];

function sub(host: string, domain: string): string | null {
  const s = host.slice(0, -domain.length - 1);
  return s && !s.includes('.') && !SKIP_SUB.has(s) ? s : null;
}
function firstSeg(path: string): string | null {
  const s = path.split('/').filter(Boolean)[0]?.split('?')[0];
  return s && /^[a-z0-9][a-z0-9_.-]{0,80}$/i.test(s) && !['embed', 'robots.txt', 'favicon.ico', 'static', 'assets', 'api', 'jobs'].includes(s.toLowerCase()) ? s : null;
}

/** SURT key "com,keka,acme)/careers/x" → host "acme.keka.com", path "/careers/x". */
function surtToHostPath(key: string): { host: string; path: string } {
  const [h, path = ''] = key.split(')');
  const host = h.split(':')[0].split(',').reverse().join('.');
  return { host, path: path.toLowerCase() };
}

/**
 * Latest crawl ids, newest first. The query server's list first; when it's
 * down (it often is), probe the file server week by week for the past year.
 */
export async function latestCrawls(n: number, now = new Date()): Promise<string[]> {
  const res = await fetch('https://index.commoncrawl.org/collinfo.json', { headers: { 'user-agent': UA }, signal: AbortSignal.timeout(20_000) }).catch(() => null);
  if (res?.ok) return ((await res.json()) as { id: string }[]).slice(0, n).map((c) => c.id);
  const found: string[] = [];
  for (let back = 0; back < 52 && found.length < n; back++) {
    const d = new Date(now.getTime() - back * 7 * 86_400_000);
    const id = `CC-MAIN-${isoWeekYear(d)}-${String(isoWeek(d)).padStart(2, '0')}`;
    if (found.includes(id)) continue;
    const head = await fetch(`${CC}/${id}/indexes/cluster.idx`, { method: 'HEAD', headers: { 'user-agent': UA }, signal: AbortSignal.timeout(15_000) }).catch(() => null);
    if (head?.ok) found.push(id);
  }
  if (!found.length) throw new Error('No Common Crawl index found');
  return found;
}

function isoWeek(d: Date): number {
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  t.setUTCDate(t.getUTCDate() + 4 - (t.getUTCDay() || 7));
  return Math.ceil(((t.getTime() - Date.UTC(t.getUTCFullYear(), 0, 1)) / 86_400_000 + 1) / 7);
}
function isoWeekYear(d: Date): number {
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  t.setUTCDate(t.getUTCDate() + 4 - (t.getUTCDay() || 7));
  return t.getUTCFullYear();
}

export function discoverFromCommonCrawl(opts: { crawls?: string[]; systems?: AtsType[]; maxBlocks?: number } = {}) {
  return track('commoncrawl', opts, async () => {
    const crawls = opts.crawls?.length ? opts.crawls : await latestCrawls(3);
    const rules = CC_RULES.filter((r) => !opts.systems?.length || opts.systems.includes(r.ats));
    let found = 0;
    let added = 0;
    for (const rule of rules) {
      const tokens = new Set<string>();
      for (const crawl of crawls) {
        for (const prefix of rule.prefixes) {
          try {
            for await (const key of ccKeys(crawl, prefix, opts.maxBlocks ?? 300)) {
              const { host, path } = surtToHostPath(key);
              const t = rule.token(host, path);
              if (t) tokens.add(rule.ats === 'zoho' || rule.ats === 'oracle' ? t : t.toLowerCase());
            }
          } catch (err) {
            logger.warn('discovery:commoncrawl-prefix-failed', { crawl, prefix, error: (err as Error).message });
          }
        }
      }
      found += tokens.size;
      added += await addCandidates(rule.ats, [...tokens], 'commoncrawl');
      logger.info('discovery:commoncrawl-system', { ats: rule.ats, found: tokens.size });
    }
    return { found, added };
  });
}

// ─── Verified seeds ──────────────────────────────────────────
// Checked by hand on 2026-10-22: each answered with live jobs.
export const VERIFIED_SEEDS: { ats: AtsType; tokens: string[] }[] = [
  {
    ats: 'successfactors',
    tokens: [
      'careers.wipro.com', 'careers.hcltech.com', 'careers.tatamotors.com', 'careers.tatapower.com', 'careers.asianpaints.com',
      'careers.bajajauto.com', 'careers.tataconsumer.com', 'careers.tataprojects.com', 'careers.cipla.com', 'careers.sunpharma.com',
      'careers.lupin.com', 'careers.biocon.com', 'jobs.capgemini.com',
    ],
  },
  { ats: 'oracle', tokens: ['jpmc.fa.oraclecloud.com|CX_1001'] },
  { ats: 'keka', tokens: ['evolve'] },
  { ats: 'freshteam', tokens: ['digitap'] },
];

export function discoverFromSeeds() {
  return track('seed', {}, async () => {
    let found = 0;
    let added = 0;
    for (const s of VERIFIED_SEEDS) {
      found += s.tokens.length;
      added += await addCandidates(s.ats, s.tokens, 'seed');
    }
    return { found, added };
  });
}

/** Registry health for the admin panel. */
export async function registryStats() {
  const { rows } = await getPgPool().query(
    `SELECT ats_type, status, COUNT(*)::int AS boards, SUM(job_count)::int AS jobs, SUM(focus_job_count)::int AS focus_jobs,
            COUNT(*) FILTER (WHERE focus_job_count > 0)::int AS focus_boards
       FROM job_boards GROUP BY ats_type, status ORDER BY ats_type, status`,
  );
  const runs = await getPgPool().query('SELECT * FROM board_discovery_runs ORDER BY started_at DESC LIMIT 20');
  const due = await getPgPool().query(
    `SELECT COUNT(*) FILTER (WHERE next_poll_at IS NULL OR next_poll_at <= NOW())::int AS due_now,
            COUNT(*) FILTER (WHERE last_polled_at > NOW() - INTERVAL '1 day')::int AS polled_24h
       FROM job_boards WHERE enabled AND status <> 'dead'`,
  );
  return { bySystem: rows, runs: runs.rows, ...due.rows[0] };
}
