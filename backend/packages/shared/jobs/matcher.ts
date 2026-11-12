import { getPgPool } from '../db/index.js';
import { loadSkillStats, weightedCoverage, yearsFit as yearsGauss } from './fit-math.js';
import { getNumber, getBool, getSetting } from '../config/settings.js';
import type { ProfileData } from '../profile/index.js';
import { extractSkills } from './normalize.js';
import { yearsOfExperience } from '../profile/years.js';

// ============================================================
// MATCHER — rules only, zero AI tokens per match.
// Score 0–100 from: role/title fit, skill overlap, location/workplace fit,
// seniority vs experience. Hard filters drop jobs the user can't take.
// ============================================================

export interface JobRow {
  id: string;
  title: string;
  company: string;
  url: string;
  first_seen_at?: string | Date | null;
  location: string | null;
  country: string | null;
  workplace: 'Remote' | 'Hybrid' | 'On-site' | null;
  employment_type: string | null;
  salary_min: string | null;
  salary_max: string | null;
  salary_currency: string | null;
  salary_period: string | null;
  posted_at: string | null;
  skills: string[];
  seniority: string | null;
  ats_type: string;
  experience_min?: string | number | null;
  experience_max?: string | number | null;
  closes_at?: string | Date | null;
  vacancies?: number | null;
}

const tokens = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9+#. ]/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length > 1 && !['and', 'the', 'of', 'for', 'with', 'i', 'ii', 'iii'].includes(t));

const EXPERIENCE_TO_SENIORITY: Record<string, string[]> = {
  'Student / fresher': ['intern', 'entry'],
  '0–2 years': ['intern', 'entry', 'mid'],
  '2–5 years': ['entry', 'mid', 'senior'],
  '5–10 years': ['mid', 'senior', 'lead', 'staff'],
  '10+ years': ['senior', 'lead', 'staff', 'executive'],
};

const ALIASES: string[][] = [
  // India: cities by their old/new names and the metro areas people commute within.
  ['bengaluru', 'bangalore', 'electronic city', 'whitefield'],
  ['delhi ncr', 'ncr', 'delhi', 'new delhi', 'gurugram', 'gurgaon', 'noida', 'greater noida', 'ghaziabad', 'faridabad'],
  ['mumbai', 'bombay', 'navi mumbai', 'thane', 'powai'],
  ['pune', 'pimpri', 'chinchwad', 'hinjewadi', 'kharadi'],
  ['hyderabad', 'secunderabad', 'cyberabad', 'gachibowli', 'hitec city'],
  ['chennai', 'madras'],
  ['kolkata', 'calcutta'],
  ['kochi', 'cochin', 'ernakulam'],
  ['thiruvananthapuram', 'trivandrum'],
  ['mysuru', 'mysore'],
  ['mangaluru', 'mangalore'],
  ['chandigarh', 'mohali', 'panchkula'],
  ['ahmedabad', 'gandhinagar'],
  ['visakhapatnam', 'vizag'],
  ['new york', 'nyc', 'brooklyn', 'jersey city'],
  // Metro areas: a job in Menlo Park is "in San Francisco" for someone who picked SF.
  ['san francisco', 'sf', 'bay area', 'south san francisco', 'oakland', 'berkeley', 'san mateo', 'redwood city', 'menlo park',
    'palo alto', 'mountain view', 'sunnyvale', 'santa clara', 'cupertino', 'san jose', 'foster city', 'burlingame'],
  ['seattle', 'bellevue', 'redmond', 'kirkland'],
  ['los angeles', 'santa monica', 'culver city', 'irvine', 'pasadena'],
];

/** "Bengaluru" should also match "Bangalore" in job locations, etc. */
function cityAliases(loc: string): string[] {
  const l = loc.toLowerCase().trim();
  const group = ALIASES.find((g) => g.includes(l));
  return group ? group : [l];
}

const CITY_COUNTRY: Record<string, string> = {
  bombay: 'IN', madras: 'IN', calcutta: 'IN', 'new delhi': 'IN', gurgaon: 'IN', nyc: 'US', sf: 'US', 'bay area': 'US',
  bengaluru: 'IN', bangalore: 'IN', hyderabad: 'IN', pune: 'IN', mumbai: 'IN', delhi: 'IN', 'delhi ncr': 'IN', gurugram: 'IN',
  noida: 'IN', chennai: 'IN', kolkata: 'IN', india: 'IN', lucknow: 'IN', 'navi mumbai': 'IN', thane: 'IN', ghaziabad: 'IN',
  faridabad: 'IN', ncr: 'IN', secunderabad: 'IN', ahmedabad: 'IN', jaipur: 'IN', kochi: 'IN', cochin: 'IN', chandigarh: 'IN',
  mohali: 'IN', indore: 'IN', coimbatore: 'IN', trivandrum: 'IN', thiruvananthapuram: 'IN', mysuru: 'IN', mysore: 'IN',
  bhubaneswar: 'IN', nagpur: 'IN', vadodara: 'IN', surat: 'IN', visakhapatnam: 'IN', bhopal: 'IN', 'new york': 'US', 'san francisco': 'US', seattle: 'US',
  usa: 'US', 'united states': 'US', london: 'GB', singapore: 'SG', toronto: 'CA',
};

/** The user's experience in years: exact if known, else their onboarding band. */
function yearsBand(p: ProfileData): { min: number; max: number } | null {
  const y = p.work?.yearsOfExperience;
  if (typeof y === 'number' && y >= 0) return { min: y, max: y };
  const bands: Record<string, { min: number; max: number }> = {
    'Student / fresher': { min: 0, max: 0 },
    '0–2 years': { min: 0, max: 2 },
    '2–5 years': { min: 2, max: 5 },
    '5–10 years': { min: 5, max: 10 },
    '10+ years': { min: 10, max: 30 },
  };
  return bands[p.work?.experienceLevel ?? ''] ?? null;
}

/** Two-letter country the person is based in: their own answer first, else where they connect from. */
export function homeCountry(p: ProfileData): string | null {
  for (const c of [p.personal?.country, p.personal?.detectedCountry]) if (c && /^[A-Za-z]{2}$/.test(c.trim())) return c.trim().toUpperCase();
  return null;
}

/**
 * What the résumé and the person's answers show beyond the skills list: tools named in their achievements, projects,
 * certifications and notes, and the titles they have held. Worked out once per profile (scoring runs thousands of times).
 */
const derivedCache = new WeakMap<ProfileData, { skills: Set<string>; pastTitles: { tokens: string[]; company: string }[] }>();
function derived(p: ProfileData) {
  let d = derivedCache.get(p);
  if (!d) {
    const text = [
      ...(p.experience ?? []).flatMap((e) => e.highlights ?? []),
      ...(p.projects ?? []).flatMap((x) => [x.description ?? '', ...(x.tech ?? [])]),
      ...(p.certifications ?? []),
      p.personal?.summary ?? '',
      p.about ?? '',
    ].join('\n');
    const skills = new Set([...(p.skills ?? []), ...extractSkills(text, 40)].map((x) => x.toLowerCase()));
    const titles = [...(p.experience ?? []).map((e) => ({ t: e.title, company: e.company })), ...(p.work?.currentTitle ? [{ t: p.work.currentTitle, company: p.work.currentEmployer ?? '' }] : [])];
    d = { skills, pastTitles: titles.filter((x) => x.t).map((x) => ({ tokens: tokens(x.t), company: x.company })).filter((x) => x.tokens.length) };
    derivedCache.set(p, d);
  }
  return d;
}

export function scoreJob(p: ProfileData, j: JobRow, opts: { regionOnly?: boolean } = {}): { score: number; reasons: string[]; eligible: boolean; matchedSkills: string[] } {
  const reasons: string[] = [];
  let score = 0;

  // Role fit (40): best token overlap between a target role and the job title.
  const roles = p.preferences?.roles ?? [];
  const titleTokens = new Set(tokens(j.title));
  let roleFit = 0;
  for (const r of roles) {
    const rt = tokens(r);
    if (!rt.length) continue;
    const hit = rt.filter((t) => titleTokens.has(t)).length / rt.length;
    roleFit = Math.max(roleFit, hit);
  }
  // A job like one they have already held counts nearly as much as one they named.
  const mineDerived = derived(p);
  let pastFit = 0;
  let pastCompany = '';
  for (const t of mineDerived.pastTitles) {
    const hit = t.tokens.filter((x) => titleTokens.has(x)).length / t.tokens.length;
    if (hit > pastFit) { pastFit = hit; pastCompany = t.company; }
  }
  const named = roleFit;
  roleFit = Math.max(roleFit, pastFit * 0.85);
  if (!roles.length && !pastFit) roleFit = 0.4;
  score += roleFit * 40;
  if (named >= 0.99) reasons.push('Matches a role you want');
  else if (named >= 0.5) reasons.push('Close to a role you want');
  else if (pastFit >= 0.99 && roleFit > named) reasons.push(pastCompany ? `Like your work at ${pastCompany}` : 'Like a role you have held');

  // Skills (30)
  const mine = mineDerived.skills;
  const overlap = j.skills.filter((s) => mine.has(s.toLowerCase()));
  // IDF-weighted, shrunk coverage: a rare skill counts more, and a job naming one skill can't score 100%.
  const skillFit = j.skills.length ? weightedCoverage(j.skills, (s) => mine.has(s.toLowerCase())) : mine.size ? 0.3 : 0.5;
  score += skillFit * 30;
  if (overlap.length) reasons.push(`${overlap.length} of your skills`);

  // Location / workplace (20)
  const regionOnly = opts.regionOnly ?? true;
  const home = homeCountry(p);
  // Remote is always welcome unless they said they only want office/hybrid.
  const wantRemote = (p.preferences?.workplace ?? []).includes('Remote') || (p.preferences?.locations ?? []).some((l) => /remote/i.test(l)) || !(p.preferences?.workplace ?? []).length;
  const locs = (p.preferences?.locations ?? []).flatMap((l) => cityAliases(l));
  const wantCountries = new Set(locs.map((l) => CITY_COUNTRY[l]).filter(Boolean));
  const userCountry = CITY_COUNTRY[(p.personal?.city ?? '').toLowerCase()] ?? [...wantCountries][0];
  const authorizedIn = new Set([...(p.authorization?.countries ?? []), ...(userCountry ? [userCountry] : []), ...(home ? [home] : [])]);
  const jobLoc = (j.location ?? '').toLowerCase();
  let locFit = 0;
  if (j.workplace === 'Remote' && wantRemote) {
    // Remote roles tied to another country usually need work authorization there.
    const foreign = j.country && authorizedIn.size && !authorizedIn.has(j.country);
    // "Remote - Somewhere" we couldn't place: likely tied to that place, so not a full fit.
    const unplaced = !j.country && jobLoc.replace(/remote|anywhere|worldwide|global|[\s,;:()/-]/g, '').length > 0;
    locFit = foreign ? 0.3 : unplaced ? 0.6 : 1;
  } else if (locs.some((l) => l !== 'remote' && jobLoc.includes(l))) locFit = 1;
  // Same country, another city: possible only by relocating — shown, but well below local roles.
  else if (j.country && wantCountries.has(j.country)) locFit = 0.3;
  // No city named: anything in their own region is a good fit; a job in another country is out when region-only.
  else if (!locs.length && j.country && authorizedIn.has(j.country)) locFit = 0.8;
  else if (!locs.length && regionOnly && authorizedIn.size && j.country && j.workplace !== 'Remote') locFit = 0;
  else if (!locs.length) locFit = 0.5;
  score += locFit * 20;
  if (locFit === 1) reasons.push(j.workplace === 'Remote' ? 'Remote' : 'In your city');
  else if (locFit === 0.8) reasons.push(home && j.country === home ? 'In your region' : 'In a country you can work in');
  else if (locFit === 0.3) reasons.push(j.workplace === 'Remote' ? `Remote (${j.country}-based)` : 'Another city — may need to relocate');

  // Workplace they didn't pick (an office job when they asked for remote/hybrid).
  const workplaces = p.preferences?.workplace ?? [];
  if (workplaces.length && j.workplace && !workplaces.includes(j.workplace)) score -= 10;

  // Seniority (10): the years the job asks for, when it says; else its title level.
  const allowed = EXPERIENCE_TO_SENIORITY[p.work?.experienceLevel ?? ''] ?? null;
  const yours = yearsBand(p);
  const jobMin = j.experience_min === null || j.experience_min === undefined ? null : Number(j.experience_min);
  const jobMax = j.experience_max === null || j.experience_max === undefined ? null : Number(j.experience_max);
  let yearsFit: number | null = null;
  if (yours && (jobMin !== null || jobMax !== null)) {
    const lo = jobMin ?? 0;
    const hi = jobMax ?? lo + 5;
    // Overlap of [lo, hi] with the user's band; a year of slack either way.
    yearsFit = yours.max + 1 >= lo && yours.min - 2 <= hi ? 1 : yours.max + 1 < lo ? -1 : 0;
    if (yearsFit === 1) reasons.push(jobMin !== null && jobMax !== null ? `Fits your experience (${lo}–${hi} yrs)` : 'Fits your experience');
  }
  const exact = yearsOfExperience(p);
  const smooth = exact !== null && (jobMin !== null || jobMax !== null) ? yearsGauss(exact, jobMin, jobMax) : null;
  const senFit = smooth !== null ? smooth : yearsFit !== null ? Math.max(yearsFit, 0) : !allowed || !j.seniority ? 0.5 : allowed.includes(j.seniority) ? 1 : 0;
  score += senFit * 10;

  // Hard filters: wrong level by a mile, or a location the user excluded entirely.
  let eligible = true;
  if (allowed && j.seniority && ['staff', 'executive'].includes(j.seniority) && !allowed.includes(j.seniority)) eligible = false;
  // Asks for clearly more years than the user has (a fresher vs "5+ years").
  if (yearsFit === -1 && jobMin !== null && yours && jobMin - yours.max >= 2) eligible = false;
  const earlyCareer = ['Student / fresher', '0–2 years'].includes(p.work?.experienceLevel ?? '');
  if (earlyCareer && j.seniority && ['senior', 'lead'].includes(j.seniority)) eligible = false;
  if ((locs.length || wantRemote || (regionOnly && authorizedIn.size)) && locFit === 0) eligible = false;
  // Remote but tied to a country they can't work in — only worth showing if they'd seek sponsorship.
  if (locFit === 0.3 && j.workplace === 'Remote' && !p.authorization?.needsSponsorship) eligible = false;
  // "Remote – Hungary": remote but tied to a place we can't confirm they can work in.
  if (j.workplace === 'Remote' && locFit === 0.6) eligible = false;
  // Has target roles, but this job matches none of them and barely any skills → not a match.
  if (roles.length && roleFit === 0 && overlap.length < 2) eligible = false;

  // A role the user can't reach without moving never outranks one they can.
  if (locFit > 0 && locFit < 0.5) score = Math.min(score, 60);

  return { score: Math.max(0, Math.round(score)), reasons, eligible, matchedSkills: overlap };
}

/** Systems whose applications go through cleanly; null = show everything. */
async function applyReadySystems(): Promise<string[] | null> {
  if (!(await getBool('jobs.apply_ready_only'))) return null;
  const list = await getSetting('jobs.apply_ready_systems');
  return Array.isArray(list) ? list.map((x) => String(x).toLowerCase()) : null;
}

const JOB_COLUMNS = `
  j.id, j.title, c.name AS company, j.url, j.location, j.country, j.workplace, j.employment_type,
  j.salary_min, j.salary_max, j.salary_currency, j.salary_period, j.posted_at, j.skills, j.seniority, b.ats_type,
  j.experience_min, j.experience_max, j.first_seen_at, j.closes_at, j.vacancies`;

/** Every job that fits the user, best first (one per company/title/location). */
async function rankedMatches(userId: string, profile: ProfileData) {
  await loadSkillStats();
  const maxAge = await getNumber('jobs.max_age_days');
  const minScore = await getNumber('jobs.match.min_score');
  const regionOnly = await getBool('jobs.region_only');
  // Only jobs in countries the user can work in (plus remote / unplaced ones):
  // with hundreds of thousands of jobs worldwide, "the newest 3000 anywhere"
  // would bury an Indian user's matches under other countries' jobs.
  const countries = [
    ...new Set(
      [
        profile.personal?.country,
        profile.personal?.detectedCountry,
        ...(profile.authorization?.countries ?? []),
        ...(profile.preferences?.locations ?? []).flatMap((l) => cityAliases(l)).map((l) => CITY_COUNTRY[l]),
      ]
        .filter((c): c is string => !!c)
        .map((c) => c.toUpperCase()),
    ),
  ];
  const ready = await applyReadySystems();
  const { rows } = await getPgPool().query<JobRow>(
    `SELECT ${JOB_COLUMNS}
       FROM jobs j
       JOIN job_boards b ON b.id = j.board_id
       LEFT JOIN companies c ON c.id = j.company_id
      WHERE j.status = 'active' AND (j.closes_at IS NULL OR j.closes_at > NOW())
        AND ($4::text[] IS NULL OR b.ats_type = ANY($4))
        AND (j.posted_at IS NULL OR j.posted_at > NOW() - ($2 || ' days')::interval)
        AND ($3::text[] IS NULL OR j.country = ANY($3) OR j.country IS NULL OR j.workplace = 'Remote')
        AND NOT EXISTS (SELECT 1 FROM job_feedback f WHERE f.user_id = $1 AND f.job_id = j.id)
        AND NOT EXISTS (SELECT 1 FROM applications a WHERE a.user_id = $1 AND a.job_id = j.id)
      ORDER BY j.posted_at DESC NULLS LAST
      LIMIT 5000`,
    [userId, maxAge, countries.length ? countries : null, ready],
  );
  // One card per role: big employers post the same title/location as several requisitions.
  const seen = new Set<string>();
  const ranked = rows
    .map((j) => ({ job: j, ...scoreJob(profile, j, { regionOnly }) }))
    .filter((r) => r.eligible && r.score >= minScore)
    .filter((r) => {
      const key = `${r.job.company}|${r.job.title.toLowerCase().trim()}|${(r.job.location ?? '').toLowerCase()}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort((a, b) => b.score - a.score || +new Date(b.job.posted_at ?? 0) - +new Date(a.job.posted_at ?? 0));
  // The pool is the newest 5000: when full, matches only reach back this many days.
  const oldest = rows.length >= 5000 ? Math.min(...rows.map((r) => +new Date(r.posted_at ?? Date.now()))) : null;
  const windowDays = oldest ? Math.max(1, Math.ceil((Date.now() - oldest) / 86_400_000)) : maxAge;
  return Object.assign(ranked, { windowDays });
}

export async function recommendJobs(userId: string, profile: ProfileData, limit = 20) {
  const ranked = await rankedMatches(userId, profile);
  // Variety: at most MAX_PER_COMPANY per company in the first pass, then fill.
  const MAX_PER_COMPANY = 2;
  const perCompany = new Map<string, number>();
  const picked: (typeof ranked)[number][] = [];
  const overflow: (typeof ranked)[number][] = [];
  for (const r of ranked) {
    const n = perCompany.get(r.job.company) ?? 0;
    if (n < MAX_PER_COMPANY) {
      perCompany.set(r.job.company, n + 1);
      picked.push(r);
    } else overflow.push(r);
    if (picked.length >= limit) break;
  }
  return [...picked, ...overflow].slice(0, limit);
}

export interface JobPulse {
  /** Jobs that fit the user right now, and how many of them appeared in the last day. */
  fits: number;
  /** The matches come from jobs posted in the last this-many days. */
  fitsWindowDays: number;
  fitsNewToday: number;
  fitCompanies: number;
  /** The user's city (first preferred location, else where they live). */
  city: { name: string; roles: number; companies: number; newToday: number } | null;
  /** Newest fitting roles, for "just in". */
  latest: { id: string; title: string; company: string; location: string | null; seenAt: string }[];
  /** Everything we keep fresh. */
  platform: { jobs: number; companies: number; addedLastHour: number; checkedAt: string | null };
  firstName: string | null;
  role: string | null;
}

let platformCache: { at: number; value: JobPulse['platform'] } | null = null;

async function platformPulse(): Promise<JobPulse['platform']> {
  if (platformCache && Date.now() - platformCache.at < 60_000) return platformCache.value;
  const { rows } = await getPgPool().query(
    `SELECT (SELECT COUNT(*)::int FROM jobs WHERE status = 'active') AS jobs,
            (SELECT COUNT(DISTINCT company_id)::int FROM jobs WHERE status = 'active') AS companies,
            (SELECT COUNT(*)::int FROM jobs WHERE first_seen_at > NOW() - INTERVAL '1 hour'
                AND COALESCE(posted_at, first_seen_at) > NOW() - INTERVAL '2 days') AS added,
            (SELECT MAX(last_polled_at) FROM job_boards WHERE last_status = 'ok') AS checked`,
  );
  const value = { jobs: rows[0].jobs, companies: rows[0].companies, addedLastHour: rows[0].added, checkedAt: rows[0].checked?.toISOString?.() ?? null };
  platformCache = { at: Date.now(), value };
  return value;
}

const titleCase = (s: string) => s.replace(/\b\w/g, (c) => c.toUpperCase());

/** The numbers behind "312 roles fit you — 41 since yesterday", for one user. */
export async function jobPulse(userId: string, profile: ProfileData): Promise<JobPulse> {
  const [ranked, platform] = await Promise.all([rankedMatches(userId, profile), platformPulse()]);
  const dayAgo = Date.now() - 86_400_000;
  // New = posted in the last day; first seen by us only stands in when the site gives no date
  // (a board found today lists jobs posted weeks ago).
  const seen = (j: JobRow) => +new Date(j.posted_at ?? j.first_seen_at ?? 0);
  const fresh = ranked.filter((r) => seen(r.job) > dayAgo);

  const home = profile.preferences?.locations?.[0] || profile.personal?.city || null;
  let city: JobPulse['city'] = null;
  if (home) {
    const aliases = cityAliases(home);
    const { rows } = await getPgPool().query(
      `SELECT COUNT(*)::int AS roles, COUNT(DISTINCT j.company_id)::int AS companies,
              COUNT(*) FILTER (WHERE COALESCE(j.posted_at, j.first_seen_at) > NOW() - INTERVAL '1 day')::int AS new_today
         FROM jobs j JOIN job_boards b ON b.id = j.board_id
        WHERE j.status = 'active' AND j.location ILIKE ANY($1) AND ($2::text[] IS NULL OR b.ats_type = ANY($2))`,
      [aliases.map((a) => `%${a}%`), await applyReadySystems()],
    );
    // "Bangalore" → "Bengaluru": the city's own name when we know it.
    const name = /bangalore/i.test(home) ? 'Bengaluru' : /gurgaon/i.test(home) ? 'Gurugram' : /bombay/i.test(home) ? 'Mumbai' : titleCase(home.trim());
    city = { name, roles: rows[0].roles, companies: rows[0].companies, newToday: rows[0].new_today };
  }
  const byNewest = [...fresh].sort((a, b) => seen(b.job) - seen(a.job));
  return {
    fits: ranked.length,
    fitsWindowDays: ranked.windowDays,
    fitsNewToday: fresh.length,
    fitCompanies: new Set(ranked.map((r) => r.job.company)).size,
    city,
    latest: byNewest.slice(0, 4).map((r) => ({
      id: r.job.id, title: r.job.title, company: r.job.company, location: r.job.location, seenAt: new Date(seen(r.job)).toISOString(),
    })),
    platform,
    firstName: profile.personal?.firstName ?? profile.personal?.fullName?.split(/\s+/)[0] ?? null,
    role: profile.preferences?.roles?.[0] ?? profile.work?.currentTitle ?? null,
  };
}

export async function searchJobs(q: {
  text?: string;
  country?: string;
  workplace?: string;
  includeRemote?: boolean;
  location?: string;
  employmentType?: string;
  experienceLevel?: 'fresher' | 'any';
  /** The person's own countries: unless they picked a country or place, only these and remote jobs are listed, theirs first. */
  region?: string[];
  page?: number;
  pageSize?: number;
}) {
  const params: unknown[] = [];
  const where = [`j.status = 'active'`, `(j.closes_at IS NULL OR j.closes_at > NOW())`];
  const ready = await applyReadySystems();
  if (ready) {
    params.push(ready);
    where.push(`b.ats_type = ANY($${params.length})`);
  }
  const ignoredSearchWords = new Set([
    'a', 'an', 'and', 'any', 'for', 'find', 'freshers', 'fresher', 'fresh', 'the', 'job', 'jobs', 'me', 'my', 'of', 'please',
    'remote', 'india', 'indian', 'location', 'role', 'roles', 'search', 'tech', 'technology', 'zero', 'experience', 'exp', 'entry', 'level', 'no', 'with', 'work',
  ]);
  const rawTerms = (q.text ?? '').toLowerCase().match(/[a-z0-9+#.]+/g) ?? [];
  const expandedTerms = rawTerms.flatMap((word) => ['tech', 'technology'].includes(word) ? ['software', 'developer', 'engineer'] : [word]);
  const searchTerms = [...new Set(expandedTerms.filter((word) => word.length > 1 && !ignoredSearchWords.has(word)))].slice(0, 6);
  const textClauses: string[] = [];
  for (const word of searchTerms) {
    params.push(`%${word}%`);
    textClauses.push(`(j.title ILIKE $${params.length} OR c.name ILIKE $${params.length} OR array_to_string(j.skills, ' ') ILIKE $${params.length})`);
  }
  if (textClauses.length) where.push(`(${textClauses.join(' OR ')})`);
  if (q.location?.trim()) {
    params.push(`%${q.location.trim()}%`);
    where.push(`j.location ILIKE $${params.length}`);
  }
  if (q.country) {
    params.push(q.country.toUpperCase());
    where.push(q.includeRemote ? `(j.country = $${params.length} OR j.workplace = 'Remote')` : `j.country = $${params.length}`);
  }
  if (q.workplace) {
    params.push(q.workplace);
    where.push(`j.workplace = $${params.length}`);
  }
  if (q.employmentType) {
    // "Full time" / "Full-Time" / "full-time" are all the same thing in the data.
    params.push(`%${q.employmentType.replace(/[-\s]+/g, '%')}%`);
    where.push(`j.employment_type ILIKE $${params.length}`);
  }
  if (q.experienceLevel === 'fresher') {
    where.push(`(j.seniority IS NULL OR j.seniority IN ('intern', 'entry'))`);
    where.push(`(j.experience_min IS NULL OR j.experience_min <= 1)`);
  }
  const region = !q.country && !q.location?.trim() && q.region?.length ? q.region.map((c) => c.toUpperCase()) : null;
  let order = 'j.posted_at DESC NULLS LAST';
  if (textClauses.length) {
    order = `(${textClauses.map((clause) => `CASE WHEN ${clause} THEN 1 ELSE 0 END`).join(' + ')}) DESC, ${order}`;
  }
  if (region) {
    params.push(region);
    where.push(`(j.country = ANY($${params.length}) OR j.workplace = 'Remote' OR j.country IS NULL)`);
    order = `CASE WHEN j.country = ANY($${params.length}) THEN 0 WHEN j.workplace = 'Remote' THEN 1 ELSE 2 END, ${order}`;
  }
  const pageSize = Math.min(Math.max(q.pageSize ?? 20, 1), 100);
  const page = Math.max(q.page ?? 1, 1);
  params.push(pageSize + 1, (page - 1) * pageSize);
  const { rows } = await getPgPool().query<JobRow>(
    `SELECT ${JOB_COLUMNS} FROM jobs j JOIN job_boards b ON b.id = j.board_id LEFT JOIN companies c ON c.id = j.company_id
      WHERE ${where.join(' AND ')}
      ORDER BY ${order}
      LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params,
  );
  // One extra row says whether there is a next page — an exact count over 700k jobs isn't worth its cost.
  return { jobs: rows.slice(0, pageSize), page, pageSize, hasMore: rows.length > pageSize };
}

export async function getJob(jobId: string) {
  const { rows } = await getPgPool().query(
    `SELECT ${JOB_COLUMNS}, j.description, j.department FROM jobs j JOIN job_boards b ON b.id = j.board_id
       LEFT JOIN companies c ON c.id = j.company_id WHERE j.id = $1`,
    [jobId],
  );
  return rows[0] ?? null;
}

/** Shape sent to the app (matches the frontend JobListing type). */
export function toListing(j: JobRow, score?: number, reasons?: string[], skills?: string[]) {
  const fmt = (n: string | null) => (n ? Number(n) : null);
  const min = fmt(j.salary_min);
  const max = fmt(j.salary_max);
  // India: lakhs per annum ("₹12–18 LPA"); elsewhere "$120k–$150k".
  const inr = j.salary_currency === 'INR';
  const lakhs = (v: number) => (v / 100000).toFixed(v % 100000 ? 1 : 0).replace(/\.0$/, '');
  const money = (v: number) =>
    inr ? lakhs(v) : `${j.salary_currency === 'USD' || !j.salary_currency ? '$' : `${j.salary_currency} `}${v >= 1000 ? `${Math.round(v / 1000)}k` : v}`;
  const salary = min && max
    ? inr ? `₹${money(min)}–${money(max)} LPA` : `${money(min)}–${money(max)}`
    : min ? (inr ? `₹${money(min)}+ LPA` : `${money(min)}+`) : undefined;
  return {
    id: j.id,
    title: j.title,
    company: j.company,
    location: j.location ?? (j.workplace === 'Remote' ? 'Remote' : 'Location not listed'),
    workplace: j.workplace ?? undefined,
    employmentType: j.employment_type ?? undefined,
    salary,
    postedAt: j.posted_at ? new Date(j.posted_at).getTime() : null,
    matchScore: score,
    matchReasons: reasons,
    matchedSkills: skills ?? j.skills.slice(0, 6),
    atsType: j.ats_type,
    url: j.url,
    closesAt: j.closes_at ? new Date(j.closes_at).getTime() : undefined,
    vacancies: j.vacancies ?? undefined,
  };
}
