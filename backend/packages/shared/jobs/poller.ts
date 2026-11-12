import { getPgPool } from '../db/index.js';
import { createLogger } from '../logger/index.js';
import { getNumber, getSetting } from '../config/settings.js';
import { SOURCES, isAtsType, validateCustomConfig, type AtsType } from './sources.js';

// ============================================================
// BOARD REGISTRY + POLLER
// Upserts every job a board lists; jobs that disappear are marked closed.
// ============================================================

const logger = createLogger('jobs-poller');

/** Starter registry — verified live boards, India + US. Admins add more. */
export const SEED_BOARDS: Array<{ atsType: AtsType; token: string; company: string; country?: string }> = [
  { atsType: 'greenhouse', token: 'stripe', company: 'Stripe' },
  { atsType: 'greenhouse', token: 'airbnb', company: 'Airbnb' },
  { atsType: 'greenhouse', token: 'figma', company: 'Figma' },
  { atsType: 'greenhouse', token: 'databricks', company: 'Databricks' },
  { atsType: 'greenhouse', token: 'coinbase', company: 'Coinbase' },
  { atsType: 'greenhouse', token: 'razorpaysoftwareprivatelimited', company: 'Razorpay', country: 'IN' },
  { atsType: 'greenhouse', token: 'groww', company: 'Groww', country: 'IN' },
  { atsType: 'greenhouse', token: 'druva', company: 'Druva', country: 'IN' },
  { atsType: 'greenhouse', token: 'gitlab', company: 'GitLab' },
  { atsType: 'greenhouse', token: 'cloudflare', company: 'Cloudflare' },
  { atsType: 'greenhouse', token: 'dropbox', company: 'Dropbox' },
  { atsType: 'greenhouse', token: 'robinhood', company: 'Robinhood' },
  { atsType: 'greenhouse', token: 'instacart', company: 'Instacart' },
  { atsType: 'lever', token: 'palantir', company: 'Palantir' },
  { atsType: 'lever', token: 'cred', company: 'CRED', country: 'IN' },
  { atsType: 'lever', token: 'meesho', company: 'Meesho', country: 'IN' },
  { atsType: 'lever', token: 'zeta', company: 'Zeta', country: 'IN' },
  { atsType: 'lever', token: 'spotify', company: 'Spotify' },
  { atsType: 'ashby', token: 'openai', company: 'OpenAI' },
  { atsType: 'ashby', token: 'notion', company: 'Notion' },
  { atsType: 'ashby', token: 'linear', company: 'Linear' },
  { atsType: 'ashby', token: 'ramp', company: 'Ramp' },
  { atsType: 'ashby', token: 'vercel', company: 'Vercel' },
  { atsType: 'ashby', token: 'supabase', company: 'Supabase' },
  { atsType: 'ashby', token: 'deel', company: 'Deel' },
  { atsType: 'ashby', token: 'plaid', company: 'Plaid' },
  // Workday: "<tenant>/wd<N>/<site>" (verified against the live CXS API, 2026-10-22).
  { atsType: 'workday', token: 'nvidia/wd5/NVIDIAExternalCareerSite', company: 'NVIDIA' },
  { atsType: 'workday', token: 'salesforce/wd12/External_Career_Site', company: 'Salesforce' },
  { atsType: 'workday', token: 'adobe/wd5/external_experienced', company: 'Adobe' },
  { atsType: 'workday', token: 'intel/wd1/External', company: 'Intel' },
  { atsType: 'workday', token: 'mastercard/wd1/CorporateCareers', company: 'Mastercard' },
  { atsType: 'workday', token: 'paypal/wd1/jobs', company: 'PayPal' },
  { atsType: 'workday', token: 'cisco/wd5/Cisco_Careers', company: 'Cisco' },
];

/** A notice feed whose newest post is older than this has stopped, not gone quiet. */
const STALE_FEED_DAYS = 14;

/** Government notices (public WordPress APIs of notice aggregators; `rr:` = rojgarresult.com, bare = sarkarinaukri.com): one board per department group. */
export const GOV_BOARDS = ['rr:all', 'all', 'india-govt-jobs', 'psu-jobs', 'banking-jobs', 'railway-jobs', 'defence-jobs', 'psc-jobs', 'ssc', 'state-jobs', 'education-jobs', 'engineering-jobs'];

/** Idempotent: existing registries get the government boards too, not just fresh ones. */
export async function ensureGovernmentBoards(): Promise<void> {
  for (const token of GOV_BOARDS) {
    const { rows } = await getPgPool().query(`SELECT 1 FROM job_boards WHERE ats_type = 'sarkari' AND board_token = $1`, [token]);
    if (!rows.length) await addBoard({ atsType: 'sarkari', token, company: `Government jobs · ${token}`, country: 'IN', pollIntervalMinutes: 60 });
  }
}

async function upsertCompany(name: string, country?: string | null): Promise<string> {
  const { rows } = await getPgPool().query(
    `INSERT INTO companies (name, country) VALUES ($1, $2)
     ON CONFLICT ((lower(name))) DO UPDATE SET country = COALESCE(companies.country, EXCLUDED.country)
     RETURNING id`,
    [name.trim(), country ?? null],
  );
  return rows[0].id;
}

export async function addBoard(input: {
  atsType: string; token: string; company: string; country?: string; pollIntervalMinutes?: number; config?: Record<string, unknown>;
}) {
  if (!isAtsType(input.atsType)) throw Object.assign(new Error(`Unsupported system "${input.atsType}"`), { statusCode: 400 });
  if (input.atsType === 'custom') validateCustomConfig(input.config);
  const companyId = await upsertCompany(input.company, input.country);
  const { rows } = await getPgPool().query(
    `INSERT INTO job_boards (company_id, ats_type, board_token, country, poll_interval_minutes, config)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (ats_type, board_token) DO UPDATE SET company_id = EXCLUDED.company_id, config = EXCLUDED.config
     RETURNING *`,
    [companyId, input.atsType, input.token.trim(), input.country ?? null, input.pollIntervalMinutes ?? 180, JSON.stringify(input.config ?? {})],
  );
  return rows[0];
}

/** A readable company name from a board token when the system doesn't name it ("acme-labs" → "Acme Labs"). */
export function nameFromToken(ats: string, token: string): string {
  let t = token;
  if (ats === 'workday') t = token.split('/')[0];
  else if (ats === 'oracle') t = token.split('|')[0].split('.')[0];
  else if (ats === 'zoho') t = token.split('.')[0];
  else if (ats === 'successfactors') t = token.replace(/^(careers|jobs)\./, '').split('.')[0];
  return t
    .replace(/[-_.]+/g, ' ')
    .replace(/\b(careers?|jobs|inc|llc|ltd|external)\b/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\b\w/g, (c) => c.toUpperCase()) || token;
}

/** Minutes until a board's next poll: by what it holds, longer while nothing changes. */
async function nextPollMinutes(b: { jobs: number; focus: number; unchanged: number }): Promise<number> {
  const [focusMin, otherMin, emptyMin, maxBackoff] = await Promise.all([
    getNumber('jobs.poll.focus_minutes'),
    getNumber('jobs.poll.other_minutes'),
    getNumber('jobs.poll.empty_minutes'),
    getNumber('jobs.poll.max_backoff'),
  ]);
  const base = b.jobs === 0 ? emptyMin : b.focus > 0 ? focusMin : otherMin;
  // Every 3 unchanged polls doubles the wait, up to max_backoff×.
  const factor = Math.min(2 ** Math.floor(b.unchanged / 3), maxBackoff);
  // ±10% jitter so boards discovered together don't stay in lockstep.
  return Math.round(base * factor * (0.9 + Math.random() * 0.2));
}

/** Insert the starter registry if the registry is empty. */
export async function seedBoardsIfEmpty(): Promise<number> {
  await ensureGovernmentBoards();
  const { rows } = await getPgPool().query(`SELECT COUNT(*)::int AS n FROM job_boards WHERE ats_type <> 'sarkari'`);
  if (rows[0].n > 0) return 0;
  for (const b of SEED_BOARDS) await addBoard(b);
  logger.info('boards:seeded', { count: SEED_BOARDS.length });
  return SEED_BOARDS.length;
}

/**
 * Boards to poll now: the most overdue known boards, plus a separate, smaller
 * share of newly discovered candidates (so a 50k discovery import never
 * starves the boards people are actually applying from).
 */
export async function dueBoards(limit: number, candidates = 0): Promise<string[]> {
  // Claimed with a 30-minute lease (next_poll_at pushed out) so a board still
  // waiting in the queue isn't queued again; the poll then sets the real time.
  const { rows } = await getPgPool().query(
    `WITH known AS (
       SELECT id FROM job_boards
        WHERE enabled AND status IN ('active', 'empty') AND (next_poll_at IS NULL OR next_poll_at <= NOW())
        ORDER BY next_poll_at NULLS FIRST LIMIT $1 FOR UPDATE SKIP LOCKED
     ), fresh AS (
       SELECT id FROM job_boards
        WHERE enabled AND status = 'candidate' AND (next_poll_at IS NULL OR next_poll_at <= NOW())
        -- Systems Indian employers use are checked first, then the rest by age.
        ORDER BY (ats_type IN ('keka', 'zoho', 'freshteam', 'successfactors', 'oracle')) DESC, created_at
        LIMIT $2 FOR UPDATE SKIP LOCKED
     )
     UPDATE job_boards b SET next_poll_at = NOW() + INTERVAL '30 minutes'
      WHERE b.id IN (SELECT id FROM known UNION ALL SELECT id FROM fresh)
     RETURNING b.id`,
    [limit, candidates],
  );
  return rows.map((r) => r.id);
}

/**
 * At most N polls per system at once in this process (Workday tenants share
 * infrastructure; dozens of parallel calls get connections reset).
 */
const LIMIT_PER_SYSTEM: Partial<Record<string, number>> = { workday: 6, oracle: 6, successfactors: 4 };
const inFlight = new Map<string, number>();
const waiters = new Map<string, (() => void)[]>();
async function withSystemSlot<T>(ats: string, fn: () => Promise<T>): Promise<T> {
  const limit = LIMIT_PER_SYSTEM[ats];
  if (!limit) return fn();
  while ((inFlight.get(ats) ?? 0) >= limit) await new Promise<void>((r) => waiters.set(ats, [...(waiters.get(ats) ?? []), r]));
  inFlight.set(ats, (inFlight.get(ats) ?? 0) + 1);
  try {
    return await fn();
  } finally {
    inFlight.set(ats, (inFlight.get(ats) ?? 1) - 1);
    const next = waiters.get(ats)?.shift();
    next?.();
  }
}

export async function pollBoard(boardId: string): Promise<{ seen: number; closed: number; added: number; focus: number }> {
  const pool = getPgPool();
  const { rows } = await pool.query(
    `SELECT b.*, c.name AS company_name FROM job_boards b LEFT JOIN companies c ON c.id = b.company_id WHERE b.id = $1`,
    [boardId],
  );
  const board = rows[0];
  if (!board) throw new Error(`Board ${boardId} not found`);
  if (!isAtsType(board.ats_type)) throw new Error(`Unsupported system ${board.ats_type}`);

  const startedAt = new Date();
  try {
    const knownRows = await pool.query('SELECT external_id FROM jobs WHERE board_id = $1', [boardId]);
    const known = new Set<string>(knownRows.rows.map((r) => r.external_id as string));
    const focus = new Set(((await getSetting('jobs.focus_countries')) as string[] | null) ?? ['IN']);
    const { company, jobs, complete = true, estimate, newestPostAt } = await withSystemSlot(board.ats_type, () =>
      SOURCES[board.ats_type as AtsType](
        board.board_token,
        { ...(board.config ?? {}), focusCountries: [...focus], validating: board.status === 'candidate' },
        known,
      ),
    );
    // A board named from its token ("Ejgk") gets the real name once the system tells us.
    const autoNamed = board.company_name && board.company_name === nameFromToken(board.ats_type, board.board_token);
    const companyId =
      board.company_id && !(autoNamed && company && company !== board.company_name)
        ? board.company_id
        : await upsertCompany(company ?? nameFromToken(board.ats_type, board.board_token), board.country);
    if (board.company_id && companyId !== board.company_id) {
      await pool.query('UPDATE jobs SET company_id = $2 WHERE board_id = $1', [boardId, companyId]);
    }

    // One statement for the whole board: jsonb_to_recordset → upsert. A job a
    // system lists twice (Workday across pages) appears once.
    const unique = [...new Map(jobs.map((j) => [j.externalId, j])).values()];
    // Boards that list many employers (government notices) name the employer per job.
    const employerIds = new Map<string, string>();
    for (const name of new Set(unique.map((j) => j.company).filter((c): c is string => !!c))) {
      employerIds.set(name, await upsertCompany(name, board.country));
    }
    const payload = unique.map((j) => ({
      company_id: (j.company && employerIds.get(j.company)) || null,
      closes_at: j.closesAt?.toISOString() ?? null,
      vacancies: j.vacancies ?? null,
      external_id: j.externalId,
      url: j.url,
      title: j.title,
      location: j.location,
      country: j.country ?? board.country,
      workplace: j.workplace,
      employment_type: j.employmentType,
      department: j.department,
      salary_min: j.salaryMin,
      salary_max: j.salaryMax,
      salary_currency: j.salaryCurrency,
      salary_period: j.salaryPeriod,
      posted_at: j.postedAt?.toISOString() ?? null,
      description: j.description,
      skills: j.skills,
      seniority: j.seniority,
      experience_min: j.experienceMin ?? null,
      experience_max: j.experienceMax ?? null,
      partial: j.partial === true,
    }));
    const full = payload.filter((j) => !j.partial);
    // Listing-only rows (details not fetched again) refresh what the listing
    // knows and keep the stored description, skills, location.
    const partial = payload.filter((j) => j.partial);
    if (partial.length) {
      await pool.query(
        `UPDATE jobs j SET url = r.url, title = r.title, posted_at = COALESCE(j.posted_at, r.posted_at),
                status = CASE WHEN j.status = 'hidden' THEN 'hidden' ELSE 'active' END, last_seen_at = NOW()
           FROM jsonb_to_recordset($2::jsonb) AS r(external_id text, url text, title text, posted_at timestamptz)
          WHERE j.board_id = $1 AND j.external_id = r.external_id`,
        [boardId, JSON.stringify(partial)],
      );
    }
    if (full.length) {
      await pool.query(
        `INSERT INTO jobs (board_id, company_id, external_id, url, title, location, country, workplace, employment_type,
                           department, salary_min, salary_max, salary_currency, salary_period, posted_at, description,
                           skills, seniority, experience_min, experience_max, closes_at, vacancies, status, last_seen_at)
         SELECT $1, COALESCE(r.company_id, $2), r.external_id, r.url, r.title, r.location, r.country, r.workplace, r.employment_type,
                r.department, r.salary_min, r.salary_max, r.salary_currency, r.salary_period, r.posted_at, r.description,
                ARRAY(SELECT jsonb_array_elements_text(r.skills)), r.seniority, r.experience_min, r.experience_max, r.closes_at, r.vacancies, 'active', NOW()
           FROM jsonb_to_recordset($3::jsonb) AS r(
                external_id text, url text, title text, location text, country text, workplace text, employment_type text,
                department text, salary_min numeric, salary_max numeric, salary_currency text, salary_period text,
                posted_at timestamptz, description text, skills jsonb, seniority text,
                experience_min numeric, experience_max numeric, company_id uuid, closes_at timestamptz, vacancies integer)
         ON CONFLICT (board_id, external_id) DO UPDATE SET
           url = EXCLUDED.url, title = EXCLUDED.title, location = EXCLUDED.location, country = EXCLUDED.country,
           workplace = EXCLUDED.workplace, employment_type = EXCLUDED.employment_type, department = EXCLUDED.department,
           salary_min = EXCLUDED.salary_min, salary_max = EXCLUDED.salary_max, salary_currency = EXCLUDED.salary_currency,
           salary_period = EXCLUDED.salary_period, posted_at = COALESCE(jobs.posted_at, EXCLUDED.posted_at),
           description = EXCLUDED.description, skills = EXCLUDED.skills, seniority = EXCLUDED.seniority,
           experience_min = EXCLUDED.experience_min, experience_max = EXCLUDED.experience_max,
           company_id = EXCLUDED.company_id, closes_at = EXCLUDED.closes_at, vacancies = EXCLUDED.vacancies,
           status = CASE WHEN jobs.status = 'hidden' THEN 'hidden' ELSE 'active' END, last_seen_at = NOW()`,
        [boardId, companyId, JSON.stringify(full)],
      );
    }
    // A cut-short listing (caps, rate limits) says nothing about the jobs it didn't reach.
    const closed = complete
      ? await pool.query(`UPDATE jobs SET status = 'closed' WHERE board_id = $1 AND status = 'active' AND last_seen_at < $2`, [boardId, startedAt])
      : { rowCount: 0 };
    const added = payload.filter((j) => !known.has(j.external_id)).length;
    const changed = added > 0 || (closed.rowCount ?? 0) > 0;
    // A quick first look reports its estimate instead of jobs; the next poll loads them.
    const jobCount = estimate ? estimate.jobs : payload.length;
    const focusCount = estimate ? estimate.focus : payload.filter((j) => j.country && focus.has(j.country)).length;
    const nextIn = estimate && jobCount > 0
      ? 1 // relevant or not, load it properly right away
      : board.ats_type === 'sarkari'
        ? 60 // a news feed: new notices any hour, even when it is quiet right now
        : await nextPollMinutes({ jobs: jobCount, focus: focusCount, unchanged: changed ? 0 : board.unchanged_polls + 1 });
    // A notice feed that stopped publishing looks like "no jobs" — say so instead of showing a healthy empty board.
    const staleDays = newestPostAt ? Math.floor((Date.now() - newestPostAt.getTime()) / 86_400_000) : null;
    const stale = staleDays !== null && staleDays > STALE_FEED_DAYS;
    if (stale) logger.warn('board:stale', { boardId, ats: board.ats_type, token: board.board_token, newestPostAt, staleDays });
    await pool.query(
      `UPDATE job_boards SET last_polled_at = NOW(), last_status = $7, last_error = $8, failures = 0,
              job_count = $2, focus_job_count = $3, company_id = $4,
              status = CASE WHEN $2 > 0 THEN 'active' ELSE 'empty' END,
              unchanged_polls = CASE WHEN $5 THEN 0 ELSE unchanged_polls + 1 END,
              last_change_at = CASE WHEN $5 THEN NOW() ELSE last_change_at END,
              next_poll_at = NOW() + ($6 || ' minutes')::interval
        WHERE id = $1`,
      [
        boardId, jobCount, focusCount, companyId, changed, String(nextIn),
        stale ? 'stale' : 'ok',
        stale ? `Source stopped publishing ${staleDays} days ago (newest notice ${newestPostAt!.toISOString().slice(0, 10)})` : null,
      ],
    );
    logger.info('board:polled', {
      boardId, ats: board.ats_type, token: board.board_token, seen: payload.length, added, closed: closed.rowCount, focus: focusCount, nextIn,
    });
    return { seen: payload.length, closed: closed.rowCount ?? 0, added, focus: focusCount };
  } catch (err) {
    // Gone (404) twice, or a discovered candidate that never existed → dead. A candidate that has failed 5 times
    // in a row (400/403/5xx — in dev 11k Workday candidates sat at 50+ failures) never proved it exists: dead too.
    // Anything else (timeouts, 5xx, rate limits) backs off: 30 min, 1 h, 2 h … 1 day.
    const notFound = (err as { code?: string }).code === 'BOARD_NOT_FOUND';
    await pool.query(
      `UPDATE job_boards SET last_polled_at = NOW(), last_status = 'error', last_error = $2, failures = failures + 1,
              status = CASE WHEN ($3 AND (status = 'candidate' OR failures >= 1)) OR (status = 'candidate' AND failures >= 4) THEN 'dead' ELSE status END,
              next_poll_at = NOW() + (LEAST(30 * POWER(2, failures), 1440) || ' minutes')::interval
        WHERE id = $1`,
      [boardId, (err as Error).message.slice(0, 300), notFound],
    );
    throw err;
  }
}
