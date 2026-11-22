import { sarkari } from './sarkari.js';
import { detectCountry, detectWorkplace, finalize, htmlToText, validDate, type NormalizedJob } from './normalize.js';

// ============================================================
// JOB BOARD SOURCES — public JSON endpoints per applicant system.
// Each returns normalized jobs for one company board. Add a system by
// adding an entry to SOURCES.
// ============================================================

export type AtsType =
  | 'greenhouse' | 'lever' | 'ashby' | 'smartrecruiters' | 'workable' | 'recruitee' | 'breezy' | 'personio' | 'workday'
  // Systems Indian employers use (verified public endpoints, 2026-10-22)
  | 'keka' | 'zoho' | 'freshteam' | 'oracle' | 'successfactors'
  | 'sarkari'
  | 'custom';

/**
 * A board an admin defines without code: any public JSON endpoint plus a map
 * from our fields to dot-paths in each item. `{token}` in the URL is replaced.
 */
export interface CustomSourceConfig {
  url: string;
  itemsPath?: string;
  headers?: Record<string, string>;
  company?: string;
  fields: {
    id: string;
    title: string;
    url: string;
    location?: string;
    country?: string;
    department?: string;
    employmentType?: string;
    postedAt?: string;
    description?: string;
    remote?: string;
  };
}

/**
 * `known`: external ids already stored for this board (sources with costly
 * detail calls skip them). `complete: false` = the listing was cut short
 * (caps, rate limits) — the poller then doesn't close jobs it didn't see.
 */
export type SourceFn = (
  token: string,
  config?: Record<string, unknown>,
  known?: Set<string>,
) => Promise<{
  company?: string;
  jobs: NormalizedJob[];
  complete?: boolean;
  /** Notice feeds: when the source last published anything, so a stopped feed can be flagged. */
  newestPostAt?: Date | null;
  /** A quick check that didn't load jobs (first look at a big board): its size and focus share. */
  estimate?: { jobs: number; focus: number };
}>;

async function getText(url: string, timeoutMs = 45_000): Promise<string> {
  // */* — SuccessFactors' RSS answers 406 to a narrower Accept.
  const res = await politeFetch(url, { headers: { 'user-agent': UA, accept: '*/*' } }, timeoutMs);
  if (res.status === 404 || res.status === 410) throw Object.assign(new Error('Board not found'), { code: 'BOARD_NOT_FOUND' });
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${new URL(url).host}`);
  return res.text();
}

const decodeEntities = (s: string) =>
  s
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCharCode(parseInt(n, 16)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');

/** "2-5", "0 - 1 yrs", "3+ years" → { min, max } in years. */
export function parseExperience(v?: string | null): { min: number | null; max: number | null } {
  const s = (v ?? '').toLowerCase();
  const range = s.match(/(\d+(?:\.\d+)?)\s*(?:-|–|to)\s*(\d+(?:\.\d+)?)/);
  if (range) return { min: Number(range[1]), max: Number(range[2]) };
  const plus = s.match(/(\d+(?:\.\d+)?)\s*\+/);
  if (plus) return { min: Number(plus[1]), max: null };
  return { min: null, max: null };
}

const slugify = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 80) || 'job';

const UA = 'jobpilot-jobs/1.0 (+https://jobpilot.app)';

/** fetch, retrying "slow down" answers (429/503) with backoff — honours Retry-After. */
async function politeFetch(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  for (let attempt = 0; ; attempt++) {
    let res: Response;
    try {
      res = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
    } catch (err) {
      // Reset connections / DNS blips: twice more, then give up.
      if (attempt >= 2) throw err;
      await new Promise((r) => setTimeout(r, 1500 * 2 ** attempt));
      continue;
    }
    if ((res.status !== 429 && res.status !== 503) || attempt >= 3) return res;
    const retryAfter = Number(res.headers.get('retry-after'));
    await new Promise((r) => setTimeout(r, Number.isFinite(retryAfter) && retryAfter > 0 ? Math.min(retryAfter, 30) * 1000 : 2000 * 2 ** attempt));
  }
}

async function getJson<T>(url: string, timeoutMs = 45_000): Promise<T> {
  const res = await politeFetch(url, { headers: { 'user-agent': UA, accept: 'application/json' } }, timeoutMs);
  if (res.status === 404) throw Object.assign(new Error('Board not found'), { code: 'BOARD_NOT_FOUND' });
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${new URL(url).host}`);
  return (await res.json()) as T;
}

async function postJson<T>(url: string, body: unknown, timeoutMs = 45_000): Promise<T> {
  const res = await politeFetch(
    url,
    { method: 'POST', headers: { 'user-agent': UA, accept: 'application/json', 'content-type': 'application/json' }, body: JSON.stringify(body) },
    timeoutMs,
  );
  if (res.status === 404 || res.status === 422) throw Object.assign(new Error('Board not found'), { code: 'BOARD_NOT_FOUND' });
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${new URL(url).host}`);
  return (await res.json()) as T;
}

/** Run `fn` over items with at most `limit` in flight. */
async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i]);
      }
    }),
  );
  return out;
}

const COUNTRY_NAMES: Record<string, string> = {
  'united states': 'US', usa: 'US', india: 'IN', 'united kingdom': 'GB', canada: 'CA', germany: 'DE',
  singapore: 'SG', ireland: 'IE', netherlands: 'NL', france: 'FR', australia: 'AU', japan: 'JP',
  'united arab emirates': 'AE', spain: 'ES', poland: 'PL', brazil: 'BR', mexico: 'MX',
};
const countryCode = (v?: string | null) => (v ? (v.length === 2 ? v.toUpperCase() : COUNTRY_NAMES[v.toLowerCase()] ?? null) : null);

// ─── Greenhouse ──────────────────────────────────────────────
interface GreenhouseJob {
  id: number;
  title: string;
  absolute_url: string;
  location?: { name?: string };
  first_published?: string;
  updated_at?: string;
  content?: string;
  departments?: Array<{ name?: string }>;
}

async function greenhouse(token: string): Promise<{ company?: string; jobs: NormalizedJob[] }> {
  const data = await getJson<{ jobs: Array<GreenhouseJob & { company_name?: string }> }>(
    `https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(token)}/jobs?content=true`,
  );
  return {
    company: data.jobs[0]?.company_name,
    jobs: data.jobs.map((j) => {
      const description = htmlToText(j.content ?? '');
      const location = j.location?.name ?? null;
      return finalize({
        externalId: String(j.id),
        title: j.title.trim(),
        url: j.absolute_url,
        location,
        workplace: detectWorkplace(location, j.title),
        employmentType: null,
        department: j.departments?.[0]?.name ?? null,
        // first_published is the real posting date; updated_at changes on every edit.
        postedAt: validDate(j.first_published ?? j.updated_at),
        description,
        salaryMin: null,
        salaryMax: null,
        salaryCurrency: null,
        salaryPeriod: null,
      });
    }),
  };
}

// ─── Lever ───────────────────────────────────────────────────
interface LeverPosting {
  id: string;
  text: string;
  hostedUrl: string;
  createdAt?: number;
  country?: string;
  workplaceType?: string;
  categories?: { commitment?: string; location?: string; team?: string; allLocations?: string[] };
  descriptionPlain?: string;
  descriptionBodyPlain?: string;
  salaryRange?: { min?: number; max?: number; currency?: string; interval?: string };
}

async function lever(token: string): Promise<{ jobs: NormalizedJob[] }> {
  const data = await getJson<LeverPosting[]>(`https://api.lever.co/v0/postings/${encodeURIComponent(token)}?mode=json`, 90_000);
  return {
    jobs: data.map((j) => {
      const location = j.categories?.location ?? j.categories?.allLocations?.[0] ?? null;
      const wp = j.workplaceType?.toLowerCase();
      return finalize({
        externalId: j.id,
        title: j.text.trim(),
        url: j.hostedUrl,
        location,
        country: countryCode(j.country),
        workplace:
          wp === 'remote' ? 'Remote' : wp === 'hybrid' ? 'Hybrid' : wp === 'onsite' || wp === 'on-site' ? 'On-site' : detectWorkplace(location),
        employmentType: j.categories?.commitment ?? null,
        department: j.categories?.team ?? null,
        postedAt: validDate(j.createdAt),
        description: [j.descriptionPlain, j.descriptionBodyPlain].filter(Boolean).join('\n\n'),
        salaryMin: j.salaryRange?.min ?? null,
        salaryMax: j.salaryRange?.max ?? null,
        salaryCurrency: j.salaryRange?.currency ?? null,
        salaryPeriod: j.salaryRange?.interval ?? null,
      });
    }),
  };
}

// ─── Ashby ───────────────────────────────────────────────────
interface AshbyJob {
  id: string;
  title: string;
  jobUrl: string;
  location?: string;
  isListed?: boolean;
  isRemote?: boolean | null;
  workplaceType?: string | null;
  employmentType?: string;
  department?: string;
  publishedAt?: string;
  descriptionPlain?: string;
  address?: { postalAddress?: { addressCountry?: string } };
  compensation?: {
    summaryComponents?: Array<{ compensationType?: string; interval?: string; currencyCode?: string; minValue?: number; maxValue?: number }>;
  };
}

async function ashby(token: string): Promise<{ jobs: NormalizedJob[] }> {
  const data = await getJson<{ jobs: AshbyJob[] }>(
    `https://api.ashbyhq.com/posting-api/job-board/${encodeURIComponent(token)}?includeCompensation=true`,
    90_000,
  );
  return {
    jobs: data.jobs
      .filter((j) => j.isListed !== false)
      .map((j) => {
        const salary = j.compensation?.summaryComponents?.find((c) => c.compensationType === 'Salary');
        const wp = j.workplaceType?.toLowerCase();
        return finalize({
          externalId: j.id,
          title: j.title.trim(),
          url: j.jobUrl,
          location: j.location ?? null,
          country: countryCode(j.address?.postalAddress?.addressCountry),
          workplace:
            wp === 'remote' ? 'Remote' : wp === 'hybrid' ? 'Hybrid' : wp === 'onsite' ? 'On-site' : detectWorkplace(j.isRemote ?? null, j.location),
          employmentType: j.employmentType?.replace(/([a-z])([A-Z])/g, '$1-$2') ?? null,
          department: j.department ?? null,
          postedAt: validDate(j.publishedAt),
          description: j.descriptionPlain ?? '',
          salaryMin: salary?.minValue ?? null,
          salaryMax: salary?.maxValue ?? null,
          salaryCurrency: salary?.currencyCode ?? null,
          salaryPeriod: salary?.interval ?? null,
        });
      }),
  };
}

// ─── SmartRecruiters ─────────────────────────────────────────
interface SmartRecruitersPosting {
  id: string;
  name: string;
  releasedDate?: string;
  location?: { city?: string; region?: string; country?: string; remote?: boolean; hybrid?: boolean; fullLocation?: string };
  department?: { label?: string };
  typeOfEmployment?: { label?: string };
  company?: { name?: string };
}

async function smartrecruiters(token: string): Promise<{ company?: string; jobs: NormalizedJob[] }> {
  const all: SmartRecruitersPosting[] = [];
  for (let offset = 0; offset < 1000; offset += 100) {
    const page = await getJson<{ totalFound: number; content: SmartRecruitersPosting[] }>(
      `https://api.smartrecruiters.com/v1/companies/${encodeURIComponent(token)}/postings?limit=100&offset=${offset}`,
    );
    all.push(...page.content);
    if (all.length >= page.totalFound || !page.content.length) break;
  }
  return {
    company: all[0]?.company?.name,
    jobs: all.map((j) => {
      const loc = j.location;
      const location = loc?.fullLocation ?? ([loc?.city, loc?.region, loc?.country?.toUpperCase()].filter(Boolean).join(', ') || null);
      return finalize({
        externalId: j.id,
        title: j.name.trim(),
        url: `https://jobs.smartrecruiters.com/${encodeURIComponent(token)}/${j.id}`,
        location,
        country: countryCode(loc?.country),
        workplace: loc?.remote ? 'Remote' : loc?.hybrid ? 'Hybrid' : detectWorkplace(location),
        employmentType: j.typeOfEmployment?.label ?? null,
        department: j.department?.label ?? null,
        postedAt: validDate(j.releasedDate),
        description: '',
        salaryMin: null, salaryMax: null, salaryCurrency: null, salaryPeriod: null,
      });
    }),
  };
}

// ─── Workable ────────────────────────────────────────────────
interface WorkableJob {
  title: string;
  shortcode: string;
  url?: string;
  shortlink?: string;
  employment_type?: string;
  telecommuting?: boolean;
  department?: string;
  city?: string;
  state?: string;
  country?: string;
  published_on?: string;
  created_at?: string;
  description?: string;
  locations?: Array<{ country?: string; countryCode?: string; city?: string; region?: string }>;
}

async function workable(token: string): Promise<{ company?: string; jobs: NormalizedJob[] }> {
  const data = await getJson<{ name?: string; jobs: WorkableJob[] }>(
    `https://apply.workable.com/api/v1/widget/accounts/${encodeURIComponent(token)}?details=true`,
  );
  return {
    company: data.name,
    jobs: data.jobs.map((j) => {
      const l = j.locations?.[0];
      const location = [l?.city ?? j.city, l?.region ?? j.state, l?.country ?? j.country].filter(Boolean).join(', ') || null;
      return finalize({
        externalId: j.shortcode,
        title: j.title.trim(),
        url: j.url ?? j.shortlink ?? `https://apply.workable.com/${encodeURIComponent(token)}/j/${j.shortcode}/`,
        location,
        country: countryCode(l?.countryCode ?? l?.country ?? j.country),
        workplace: j.telecommuting ? 'Remote' : detectWorkplace(location),
        employmentType: j.employment_type ?? null,
        department: j.department ?? null,
        postedAt: validDate(j.published_on ?? j.created_at),
        description: htmlToText(j.description ?? ''),
        salaryMin: null, salaryMax: null, salaryCurrency: null, salaryPeriod: null,
      });
    }),
  };
}

// ─── Recruitee ───────────────────────────────────────────────
interface RecruiteeOffer {
  id: number;
  title: string;
  careers_url: string;
  location?: string;
  country_code?: string;
  remote?: boolean;
  hybrid?: boolean;
  employment_type_code?: string;
  department?: string;
  published_at?: string;
  description?: string;
  requirements?: string;
  min_salary?: number | null;
  max_salary?: number | null;
  salary?: { min?: string | number | null; max?: string | number | null; currency?: string | null; period?: string | null };
  company_name?: string;
}

async function recruitee(token: string): Promise<{ company?: string; jobs: NormalizedJob[] }> {
  const data = await getJson<{ offers: RecruiteeOffer[] }>(`https://${encodeURIComponent(token)}.recruitee.com/api/offers/`);
  const num = (v: unknown) => (v === null || v === undefined || v === '' ? null : Number(v));
  return {
    company: data.offers[0]?.company_name,
    jobs: data.offers.map((j) =>
      finalize({
        externalId: String(j.id),
        title: j.title.trim(),
        url: j.careers_url,
        location: j.location ?? null,
        country: countryCode(j.country_code),
        workplace: j.remote ? 'Remote' : j.hybrid ? 'Hybrid' : detectWorkplace(j.location),
        employmentType: j.employment_type_code?.replace(/_/g, ' ') ?? null,
        department: j.department ?? null,
        postedAt: validDate(j.published_at),
        description: htmlToText([j.description, j.requirements].filter(Boolean).join('\n\n')),
        salaryMin: num(j.salary?.min ?? j.min_salary),
        salaryMax: num(j.salary?.max ?? j.max_salary),
        salaryCurrency: j.salary?.currency ?? null,
        salaryPeriod: j.salary?.period ?? null,
      }),
    ),
  };
}

// ─── Breezy HR ───────────────────────────────────────────────
interface BreezyPosition {
  id: string;
  friendly_id?: string;
  name: string;
  url: string;
  published_date?: string;
  type?: { name?: string };
  department?: string;
  salary?: string;
  location?: { country?: { id?: string }; name?: string; is_remote?: boolean };
  company?: { name?: string };
}

async function breezy(token: string): Promise<{ company?: string; jobs: NormalizedJob[] }> {
  const data = await getJson<BreezyPosition[]>(`https://${encodeURIComponent(token)}.breezy.hr/json`);
  if (!Array.isArray(data)) throw new Error('Unexpected answer from Breezy');
  return {
    company: data[0]?.company?.name,
    jobs: data.map((j) =>
      finalize({
        externalId: j.id,
        title: j.name.trim(),
        url: j.url,
        location: j.location?.name ?? null,
        country: countryCode(j.location?.country?.id),
        workplace: j.location?.is_remote ? 'Remote' : detectWorkplace(j.location?.name),
        employmentType: j.type?.name ?? null,
        department: j.department ?? null,
        postedAt: validDate(j.published_date),
        // The list carries no description; skills come from the title until the posting is opened.
        description: '',
        salaryMin: null, salaryMax: null, salaryCurrency: null, salaryPeriod: null,
      }),
    ),
  };
}

// ─── Personio ────────────────────────────────────────────────
const xmlTag = (block: string, tag: string) => {
  const m = block.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`));
  return m ? decodeEntities(m[1].replace(/^\s*<!\[CDATA\[|\]\]>\s*$/g, '')).trim() : '';
};

async function personio(token: string): Promise<{ company?: string; jobs: NormalizedJob[] }> {
  const xml = await getText(`https://${encodeURIComponent(token)}.jobs.personio.de/xml`);
  if (!/<workzag-jobs/.test(xml)) throw Object.assign(new Error('Board not found'), { code: 'BOARD_NOT_FOUND' });
  const blocks = xml.match(/<position>[\s\S]*?<\/position>/g) ?? [];
  return {
    company: blocks[0] ? xmlTag(blocks[0], 'subcompany') || undefined : undefined,
    jobs: blocks.map((b) => {
      const office = xmlTag(b, 'office');
      const description = htmlToText(
        (b.match(/<jobDescription>[\s\S]*?<\/jobDescription>/g) ?? []).map((d) => `${xmlTag(d, 'name')}\n${xmlTag(d, 'value')}`).join('\n\n'),
      );
      return finalize({
        externalId: xmlTag(b, 'id'),
        title: xmlTag(b, 'name'),
        url: `https://${encodeURIComponent(token)}.jobs.personio.de/job/${xmlTag(b, 'id')}`,
        location: office || null,
        workplace: detectWorkplace(office, xmlTag(b, 'name')),
        employmentType: xmlTag(b, 'schedule') || xmlTag(b, 'employmentType') || null,
        department: xmlTag(b, 'department') || null,
        postedAt: validDate(xmlTag(b, 'createdAt')),
        description,
        experienceMin: Number(xmlTag(b, 'yearsOfExperience').match(/^(\d+)/)?.[1] ?? NaN) || null,
        salaryMin: null, salaryMax: null, salaryCurrency: null, salaryPeriod: null,
      });
    }).filter((j) => j.externalId && j.title),
  };
}

// ─── Custom JSON API (admin-defined) ─────────────────────────
const at = (obj: unknown, path?: string): unknown =>
  !path ? undefined : path.split('.').reduce<unknown>((o, k) => (o && typeof o === 'object' ? (o as Record<string, unknown>)[k] : undefined), obj);
const str = (v: unknown) => (v === null || v === undefined ? null : Array.isArray(v) ? v.join(', ') : String(v));

export function validateCustomConfig(config: unknown): CustomSourceConfig {
  const c = config as CustomSourceConfig;
  // http:// only for local testing outside production.
  const scheme = process.env.NODE_ENV === 'production' ? /^https:\/\// : /^https?:\/\//;
  if (!c || typeof c !== 'object' || typeof c.url !== 'string' || !scheme.test(c.url)) {
    throw Object.assign(new Error('config.url must be an https:// URL'), { statusCode: 400 });
  }
  if (!c.fields?.id || !c.fields?.title || !c.fields?.url) {
    throw Object.assign(new Error('config.fields needs at least id, title and url paths'), { statusCode: 400 });
  }
  return c;
}

async function custom(token: string, config?: Record<string, unknown>): Promise<{ company?: string; jobs: NormalizedJob[] }> {
  const c = validateCustomConfig(config);
  const url = c.url.replace('{token}', encodeURIComponent(token));
  const res = await fetch(url, {
    headers: { 'user-agent': UA, accept: 'application/json', ...(c.headers ?? {}) },
    signal: AbortSignal.timeout(45_000),
  });
  if (res.status === 404) throw Object.assign(new Error('Board not found'), { code: 'BOARD_NOT_FOUND' });
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${new URL(url).host}`);
  const data = await res.json();
  const items = c.itemsPath ? at(data, c.itemsPath) : data;
  if (!Array.isArray(items)) throw new Error(`"${c.itemsPath ?? '(root)'}" is not a list in the response`);
  const f = c.fields;
  return {
    company: c.company,
    jobs: items
      .map((it) => {
        const id = str(at(it, f.id));
        const title = str(at(it, f.title));
        const link = str(at(it, f.url));
        if (!id || !title || !link) return null;
        const location = str(at(it, f.location));
        const remote = at(it, f.remote);
        return finalize({
          externalId: id,
          title: title.trim(),
          url: link,
          location,
          country: countryCode(str(at(it, f.country))),
          workplace: remote === true ? 'Remote' : detectWorkplace(location, title),
          employmentType: str(at(it, f.employmentType)),
          department: str(at(it, f.department)),
          postedAt: validDate(str(at(it, f.postedAt))),
          description: htmlToText(str(at(it, f.description)) ?? ''),
          salaryMin: null, salaryMax: null, salaryCurrency: null, salaryPeriod: null,
        });
      })
      .filter((j): j is NormalizedJob => j !== null),
  };
}

// ─── Workday (CXS: the JSON API behind every *.myworkdayjobs.com site) ──
// Token: "<tenant>/<wdN>/<site>", e.g. "nvidia/wd5/NVIDIAExternalCareerSite".
// The listing is cheap (20 per page); each job's details (description,
// country, remote) cost one call, so only new jobs get them — up to
// config.maxDetails per poll, the rest on the next poll.
interface WorkdayListItem {
  title: string;
  externalPath: string;
  locationsText?: string;
  postedOn?: string;
  bulletFields?: string[];
}
interface WorkdayDetail {
  jobPostingInfo: {
    title: string;
    jobDescription?: string;
    location?: string;
    additionalLocations?: string[];
    startDate?: string;
    timeType?: string;
    remoteType?: string;
    country?: { descriptor?: string };
    jobRequisitionLocation?: { country?: { alpha2Code?: string; descriptor?: string } };
    canApply?: boolean;
  };
}

export function parseWorkdayToken(token: string): { tenant: string; wd: string; site: string; host: string; api: string } {
  const [tenant, wd, site] = token.split('/');
  if (!tenant || !/^wd\d+$/.test(wd ?? '') || !site) throw new Error('Workday token must look like "<tenant>/wd<N>/<site>"');
  const host = `https://${tenant}.${wd}.myworkdayjobs.com`;
  return { tenant, wd, site, host, api: `${host}/wday/cxs/${tenant}/${site}` };
}

/** "Posted Today" / "Posted 3 Days Ago" / "Posted 30+ Days Ago" → a date. */
export function workdayPostedOn(text?: string, now = new Date()): Date | null {
  const s = (text ?? '').toLowerCase();
  const days = /today/.test(s) ? 0 : /yesterday/.test(s) ? 1 : Number(s.match(/(\d+)\+?\s+days?\s+ago/)?.[1] ?? NaN);
  if (Number.isNaN(days)) return null;
  return new Date(now.getTime() - days * 86_400_000);
}

async function workday(token: string, config?: Record<string, unknown>, known = new Set<string>()) {
  const { tenant, host, api, site } = parseWorkdayToken(token);
  const focus = new Set(Array.isArray(config?.focusCountries) ? (config!.focusCountries as string[]) : []);
  // A newly discovered board: two listing pages are enough to tell whether it's
  // alive and hires in the focus countries — not 500 listings + 150 detail calls.
  if (config?.validating) {
    const first = await postJson<{ total?: number; jobPostings?: WorkdayListItem[] }>(`${api}/jobs`, { appliedFacets: {}, limit: 20, offset: 0, searchText: '' });
    const second = (first.total ?? 0) > 20
      ? await postJson<{ jobPostings?: WorkdayListItem[] }>(`${api}/jobs`, { appliedFacets: {}, limit: 20, offset: 20, searchText: '' }).catch(() => ({ jobPostings: [] }))
      : { jobPostings: [] };
    const sample = [...(first.jobPostings ?? []), ...(second.jobPostings ?? [])];
    const inFocus = sample.filter((j) => focus.has(detectCountry(j.locationsText) ?? '')).length;
    const total = first.total ?? sample.length;
    return { jobs: [], complete: false, estimate: { jobs: total, focus: sample.length ? Math.round((inFocus / sample.length) * total) : 0 } };
  }
  const maxJobs = Math.min(Number(config?.maxJobs ?? 500) || 500, 2000);
  const maxDetails = Math.min(Number(config?.maxDetails ?? 150) || 150, 1000);
  const list: WorkdayListItem[] = [];
  // Workday sends the total only with the first page (later pages say 0).
  let total = Number.POSITIVE_INFINITY;
  for (let offset = 0; offset < maxJobs && offset < total; offset += 20) {
    let page: { total?: number; jobPostings?: WorkdayListItem[] };
    try {
      page = await postJson(`${api}/jobs`, {
        appliedFacets: {},
        limit: 20,
        offset,
        searchText: typeof config?.searchText === 'string' ? config.searchText : '',
      });
    } catch (err) {
      // Rate-limited part-way: keep what we have; the next poll continues.
      if (list.length) break;
      throw err;
    }
    if (offset === 0 && page.total) total = page.total;
    list.push(...(page.jobPostings ?? []).filter((j) => j?.externalPath && j.title));
    if (!page.jobPostings?.length) break;
  }
  const idOf = (j: WorkdayListItem) => j.externalPath.split('/').pop() ?? j.externalPath;
  // Details (description, country) cost a call each: spend them on jobs that may be in
  // the focus countries ("India, Bengaluru", "3 Locations"); others are kept from the listing.
  const maybeFocus = (j: WorkdayListItem) => !focus.size || focus.has(detectCountry(j.locationsText) ?? '') || !detectCountry(j.locationsText);
  const fresh = list.filter((j) => !known.has(idOf(j)) && maybeFocus(j)).slice(0, maxDetails);
  const details = new Map<string, WorkdayDetail['jobPostingInfo']>();
  await mapLimit(fresh, 3, async (j) => {
    const d = await getJson<WorkdayDetail>(`${api}${j.externalPath}`).catch(() => null);
    if (d?.jobPostingInfo) details.set(idOf(j), d.jobPostingInfo);
  });

  const jobs: NormalizedJob[] = [];
  for (const j of list) {
    const id = idOf(j);
    const d = details.get(id);
    const url = `${host}/en-US/${site}${j.externalPath}`;
    if (!d && !known.has(id)) {
      // Clearly outside the focus countries: listing data is enough.
      if (!maybeFocus(j)) {
        jobs.push(finalize({
          externalId: id, title: j.title.trim(), url, location: j.locationsText ?? null, workplace: detectWorkplace(j.locationsText ?? null),
          employmentType: null, department: null, postedAt: workdayPostedOn(j.postedOn), description: '',
          salaryMin: null, salaryMax: null, salaryCurrency: null, salaryPeriod: null,
        }));
      }
      continue; // focus candidates without details yet: next poll
    }
    if (!d) {
      jobs.push({
        externalId: id, title: j.title.trim(), url, location: null, country: null, workplace: null,
        employmentType: null, department: null, postedAt: workdayPostedOn(j.postedOn), description: '',
        skills: [], seniority: null, salaryMin: null, salaryMax: null, salaryCurrency: null, salaryPeriod: null, partial: true,
      });
      continue;
    }
    const locations = [d.location, ...(d.additionalLocations ?? [])].filter(Boolean) as string[];
    const location = locations.join('; ') || j.locationsText || null;
    jobs.push(
      finalize({
        externalId: id,
        title: d.title?.trim() || j.title.trim(),
        url,
        location,
        country: countryCode(d.jobRequisitionLocation?.country?.alpha2Code ?? d.country?.descriptor),
        workplace: /remote/i.test(`${d.remoteType ?? ''} ${location ?? ''}`) ? 'Remote' : /hybrid/i.test(d.remoteType ?? '') ? 'Hybrid' : detectWorkplace(location),
        employmentType: d.timeType ?? null,
        department: null,
        postedAt: validDate(d.startDate) ?? workdayPostedOn(j.postedOn),
        description: htmlToText(d.jobDescription ?? ''),
        salaryMin: null, salaryMax: null, salaryCurrency: null, salaryPeriod: null,
      }),
    );
  }
  const company = typeof config?.company === 'string' && config.company ? config.company : tenant.charAt(0).toUpperCase() + tenant.slice(1);
  return { company, jobs };
}

// ─── Keka (keka.com/careers) ─────────────────────────────────
// Token: the subdomain ("evolve" for evolve.keka.com). The careers page names
// the org id; the embed endpoint returns every active job with locations,
// experience range and salary.
interface KekaJob {
  id: number;
  title: string;
  description?: string;
  departmentName?: string;
  jobLocations?: { city?: string; state?: string; countryName?: string; country?: string; name?: string }[];
  jobType?: number;
  experience?: string;
  salaryRange?: { minimum?: number; maximum?: number; currency?: string; salaryPeriod?: number } | null;
  publishedOn?: string;
  isRemote?: boolean;
}

async function keka(token: string) {
  const host = `https://${token}.keka.com`;
  const page = await getText(`${host}/careers/`);
  const org = page.match(/\/ats\/documents\/([0-9a-f-]{36})\//i)?.[1];
  if (!org) throw Object.assign(new Error('Keka careers page not found'), { code: 'BOARD_NOT_FOUND' });
  const company = decodeEntities(page.match(/<title>\s*Careers at ([^<]+)<\/title>/i)?.[1]?.trim() ?? '') || undefined;
  const list = await getJson<KekaJob[]>(`${host}/careers/api/embedjobs/default/active/${org}`);
  return {
    company,
    jobs: list.map((j) => {
      const locs = (j.jobLocations ?? []).map((l) => [l.city, l.state, l.countryName ?? l.country].filter(Boolean).join(', ')).filter(Boolean);
      const location = [...new Set(locs)].join('; ') || null;
      const exp = parseExperience(j.experience);
      const sal = j.salaryRange && (j.salaryRange.minimum || j.salaryRange.maximum) ? j.salaryRange : null;
      return finalize({
          externalId: String(j.id),
          title: j.title.trim(),
          url: `${host}/careers/jobdetails/${j.id}`,
          location,
          workplace: j.isRemote ? 'Remote' : detectWorkplace(location),
          employmentType: null,
          department: j.departmentName ?? null,
          postedAt: validDate(j.publishedOn),
          description: htmlToText(j.description ?? ''),
          salaryMin: sal?.minimum || null,
          salaryMax: sal?.maximum || null,
          salaryCurrency: sal?.currency ?? null,
          salaryPeriod: sal ? 'year' : null,
          // The system's own range wins; otherwise it's read from the description.
          experienceMin: exp.min ?? undefined,
          experienceMax: exp.max ?? undefined,
        });
    }),
  };
}

// ─── Zoho Recruit (*.zohorecruit.{in,com,eu,…}/jobs/Careers) ─────────
// Token: the careers host ("airpay.zohorecruit.com"). The page carries the
// jobs as escaped JSON in a hidden input.
interface ZohoJob {
  id: string;
  Posting_Title?: string;
  Job_Opening_Name?: string;
  City?: string;
  State?: string;
  Country?: string;
  Job_Type?: string;
  Work_Experience?: string | null;
  Industry?: string;
  Date_Opened?: string;
  Remote_Job?: boolean;
  Job_Description?: string;
}

async function zoho(token: string) {
  const host = token.includes('.') ? token : `${token}.zohorecruit.in`;
  const page = await getText(`https://${host}/jobs/Careers`);
  if (/cl-error-block/.test(page) && !/Posting_Title/.test(page)) {
    throw Object.assign(new Error('Careers site is switched off'), { code: 'BOARD_NOT_FOUND' });
  }
  const m = page.match(/value="(\[[^"]*?Posting_Title[^"]*\])"/);
  const list: ZohoJob[] = m ? JSON.parse(decodeEntities(m[1])) : [];
  const company =
    decodeEntities(page.match(/<meta property="og:site_name" content="([^"]+)"/i)?.[1] ?? '').trim() ||
    decodeEntities(page.match(/<title>\s*([^<]+?)\s+Careers\s*<\/title>/i)?.[1] ?? '').trim() ||
    undefined;
  return {
    company,
    jobs: list.map((j) => {
      const title = (j.Posting_Title || j.Job_Opening_Name || 'Job').trim();
      const location = [j.City, j.State, j.Country].filter(Boolean).join(', ') || null;
      const exp = parseExperience(j.Work_Experience);
      return finalize({
          externalId: j.id,
          title,
          url: `https://${host}/jobs/Careers/${j.id}/${slugify(title)}?source=CareerSite`,
          location,
          workplace: j.Remote_Job ? 'Remote' : detectWorkplace(location),
          employmentType: j.Job_Type ?? null,
          department: j.Industry ?? null,
          postedAt: validDate(j.Date_Opened),
          description: htmlToText(j.Job_Description ?? ''),
          salaryMin: null, salaryMax: null, salaryCurrency: null, salaryPeriod: null,
          experienceMin: exp.min ?? undefined,
          experienceMax: exp.max ?? undefined,
        });
    }),
  };
}

// ─── Freshteam (*.freshteam.com/jobs) ────────────────────────
// Token: the subdomain. The careers widget endpoint lists jobs + branches.
interface FreshteamJob {
  id: number;
  title: string;
  description?: string;
  url: string;
  /** Freshteam's own job page id: https://<sub>.freshteam.com/jobs/<unique_id> holds the form. */
  unique_id?: string;
  remote?: boolean;
  created_at?: string;
  branch_id?: number;
  job_type?: number;
  deleted?: boolean;
  status?: number;
}

async function freshteam(token: string) {
  const data = await getJson<{
    jobs: FreshteamJob[];
    branches?: { id: number; city?: string; state?: string; country_code?: string; name?: string }[];
  }>(`https://${token}.freshteam.com/hire/widgets/jobs.json`);
  const branch = new Map((data.branches ?? []).map((b) => [b.id, b]));
  return {
    jobs: (data.jobs ?? [])
      .filter((j) => !j.deleted)
      .map((j) => {
        const b = j.branch_id ? branch.get(j.branch_id) : undefined;
        const location = [b?.city, b?.state, b?.country_code].filter(Boolean).join(', ') || b?.name || null;
        return finalize({
          externalId: String(j.id),
          title: j.title.trim(),
          // The widget's url is the company's embed page; the form lives on Freshteam's own page.
          url: j.unique_id ? `https://${token}.freshteam.com/jobs/${j.unique_id}` : j.url,
          location,
          country: countryCode(b?.country_code),
          workplace: j.remote ? 'Remote' : detectWorkplace(location),
          employmentType: null,
          department: null,
          postedAt: validDate(j.created_at),
          description: htmlToText(j.description ?? ''),
          salaryMin: null, salaryMax: null, salaryCurrency: null, salaryPeriod: null,
        });
      }),
  };
}

// ─── Oracle Recruiting Cloud (candidate experience REST) ─────
// Token: "<host>|<siteNumber>", e.g. "jpmc.fa.oraclecloud.com|CX_1001".
// Big tenants list thousands of jobs worldwide, so by default only the
// focus countries are fetched (their location facet id is looked up).
interface OracleReq {
  Id: string;
  Title: string;
  PostedDate?: string;
  PrimaryLocation?: string;
  PrimaryLocationCountry?: string;
  ShortDescriptionStr?: string;
  WorkplaceType?: string;
  JobFamily?: string;
  secondaryLocations?: { Name?: string }[];
}

async function oracle(token: string, config?: Record<string, unknown>) {
  const [host, site] = token.split('|');
  if (!host || !site) throw new Error('Oracle token must look like "<host>|<siteNumber>"');
  const api = `https://${host}/hcmRestApi/resources/latest/recruitingCEJobRequisitions`;
  const finder = (extra: string) => `${api}?onlyData=true&expand=requisitionList.secondaryLocations&finder=findReqs;siteNumber=${encodeURIComponent(site)},${extra}`;
  const countries = Array.isArray(config?.countries) ? (config!.countries as string[]) : ['India'];
  let locationIds: number[] = [];
  if (countries.length) {
    const facets = await getJson<{ items: { locationsFacet?: { Name?: string; Id?: number }[] }[] }>(
      `${api}?onlyData=true&expand=locationsFacet&finder=findReqs;siteNumber=${encodeURIComponent(site)},facetsList=LOCATIONS,limit=1`,
    );
    locationIds = (facets.items?.[0]?.locationsFacet ?? []).filter((f) => f.Id && countries.includes(f.Name ?? '')).map((f) => f.Id!);
    if (!locationIds.length) return { jobs: [], complete: true }; // no jobs in the focus countries
  }
  const maxJobs = Math.min(Number(config?.maxJobs ?? 1000) || 1000, 5000);
  const reqs: OracleReq[] = [];
  let complete = true;
  for (const loc of locationIds.length ? locationIds : [null]) {
    let total = Number.POSITIVE_INFINITY;
    for (let offset = 0; offset < total; offset += 25) {
      if (reqs.length >= maxJobs) {
        complete = false;
        break;
      }
      const page = await getJson<{ items: { TotalJobsCount?: number; requisitionList?: OracleReq[] }[] }>(
        finder(`limit=25,offset=${offset},sortBy=POSTING_DATES_DESC${loc ? `,locationId=${loc}` : ''}`),
      );
      const it = page.items?.[0];
      if (offset === 0) total = it?.TotalJobsCount ?? 0;
      reqs.push(...(it?.requisitionList ?? []));
      if (!it?.requisitionList?.length) break;
    }
  }
  // Tenant hosts are codes ("ejgk.fa.em2…"); the career site names the company.
  const sitePage = await getText(`https://${host}/hcmUI/CandidateExperience/en/sites/${site}/`).catch(() => '');
  const company =
    decodeEntities(sitePage.match(/og:site_name" content="([^"]+)"/)?.[1] ?? sitePage.match(/<title>([^<]+)<\/title>/)?.[1] ?? '')
      .replace(/\s*[-|–:]?\s*(careers?( site| page)?|jobs|job search|candidate experience|talent acquisition( team)?|recruitment|external)\s*$/gi, '')
      .replace(/\s*[-|–:]?\s*(careers?( site| page)?|jobs|job search|candidate experience|talent acquisition( team)?|recruitment|external)\s*$/gi, '')
      .trim() || undefined;
  return {
    company,
    complete,
    jobs: reqs.map((r) => {
      const locations = [r.PrimaryLocation, ...(r.secondaryLocations ?? []).map((l) => l.Name)].filter(Boolean) as string[];
      const location = [...new Set(locations)].join('; ') || null;
      return finalize({
        externalId: r.Id,
        title: r.Title.trim(),
        url: `https://${host}/hcmUI/CandidateExperience/en/sites/${site}/job/${r.Id}`,
        location,
        country: countryCode(r.PrimaryLocationCountry),
        workplace: /remote/i.test(r.WorkplaceType ?? '') ? 'Remote' : /hybrid/i.test(r.WorkplaceType ?? '') ? 'Hybrid' : detectWorkplace(location),
        employmentType: null,
        department: r.JobFamily ?? null,
        postedAt: validDate(r.PostedDate),
        description: r.ShortDescriptionStr ?? '',
        salaryMin: null, salaryMax: null, salaryCurrency: null, salaryPeriod: null,
      });
    }),
  };
}

// ─── SAP SuccessFactors career sites (/services/rss/job/ + sitemap) ──
// Token: the careers host ("careers.wipro.com"). The sitemap lists every job
// (title and often the city are in the URL); the RSS feed carries the 20
// newest with full details. Wipro, HCLTech, Tata group, Cipla, Sun Pharma…
const INDIAN_CITY = /^(bengaluru|bangalore|hyderabad|pune|mumbai|navi mumbai|thane|delhi|new delhi|gurugram|gurgaon|noida|chennai|kolkata|ahmedabad|jaipur|kochi|cochin|lucknow|chandigarh|indore|coimbatore|trivandrum|thiruvananthapuram|mysuru|mysore|bhubaneswar|nagpur|vadodara|surat|visakhapatnam|vizag|mohali|sanand|jamshedpur|nashik|aurangabad|goa)$/i;

function sfFromUrl(url: string): { id: string; title: string; location: string | null } | null {
  const m = url.match(/\/job\/([^/]+)\/(\d{5,})\/?/);
  if (!m) return null;
  let parts = decodeURIComponent(m[1]).split('-').filter(Boolean);
  let location: string | null = null;
  if (parts.length > 1 && INDIAN_CITY.test(parts[0])) {
    location = parts[0];
    parts = parts.slice(1);
  }
  // Trailing "IND-560035" / "MH" style location codes aren't part of the title.
  while (parts.length > 1 && /^([A-Z]{2,3}|\d{5,6})$/.test(parts[parts.length - 1])) parts = parts.slice(0, -1);
  // URLs swap "." for "_" ("Sr_ Manager" → "Sr. Manager").
  const title = parts.join(' ').replace(/_(?=\s|$)/g, '.').replace(/_/g, ' ').replace(/\s+/g, ' ').trim();
  return { id: m[2], title, location };
}

async function successfactors(token: string, config?: Record<string, unknown>) {
  const base = `https://${token.replace(/^https?:\/\//, '').replace(/\/$/, '')}`;
  const [rss, sitemap] = await Promise.all([
    getText(`${base}/services/rss/job/?locale=en_US&keywords=`),
    getText(`${base}/sitemap.xml`).catch(() => ''),
  ]);
  const jobs = new Map<string, NormalizedJob>();
  for (const item of rss.match(/<item>[\s\S]*?<\/item>/g) ?? []) {
    const tag = (t: string) => decodeEntities((item.match(new RegExp(`<${t}>([\\s\\S]*?)</${t}>`))?.[1] ?? '').replace(/^<!\[CDATA\[|\]\]>$/g, '').trim());
    const link = tag('link');
    const parsed = sfFromUrl(link);
    if (!parsed) continue;
    // "Kubernetes (Bengaluru, IND-29, IN, 560035)" → title + location.
    const rawTitle = tag('title');
    const loc = rawTitle.match(/\(([^()]*)\)\s*$/)?.[1] ?? null;
    const location = loc ? loc.split(',').map((x) => x.trim()).filter((x) => !/^(IND-\d+|\d{5,6})$/.test(x)).join(', ') : parsed.location;
    jobs.set(parsed.id, finalize({
      externalId: parsed.id,
      title: rawTitle.replace(/\s*\([^()]*\)\s*$/, '').trim() || parsed.title,
      url: link.replace(/\?.*$/, ''),
      location,
      workplace: detectWorkplace(location),
      employmentType: null,
      department: null,
      postedAt: validDate(tag('pubDate')),
      description: htmlToText(tag('description')),
      salaryMin: null, salaryMax: null, salaryCurrency: null, salaryPeriod: null,
    }));
  }
  const urls = sitemap.match(/<loc>[^<]*\/job\/[^<]*<\/loc>/g) ?? [];
  for (const raw of urls.slice(0, Math.min(Number(config?.maxJobs ?? 20_000) || 20_000, 50_000))) {
    const url = decodeEntities(raw.replace(/<\/?loc>/g, ''));
    const p = sfFromUrl(url);
    if (!p || jobs.has(p.id)) continue;
    jobs.set(p.id, finalize({
      externalId: p.id, title: p.title, url: url.replace(/\?.*$/, ''), location: p.location,
      workplace: null, employmentType: null, department: null, postedAt: null, description: '',
      salaryMin: null, salaryMax: null, salaryCurrency: null, salaryPeriod: null,
    }));
  }
  // Without a sitemap only the newest 20 are known: don't close the rest.
  return { jobs: [...jobs.values()], complete: urls.length > 0 };
}

export const SOURCES: Record<AtsType, SourceFn> = {
  greenhouse,
  lever,
  ashby,
  smartrecruiters,
  workable,
  recruitee,
  breezy,
  personio,
  workday,
  keka,
  zoho,
  freshteam,
  oracle,
  successfactors,
  sarkari,
  custom,
};

/** For the admin "add a source" form. */
export const SOURCE_INFO: Record<AtsType, { label: string; tokenHint: string; example: string }> = {
  greenhouse: { label: 'Greenhouse', tokenHint: 'boards.greenhouse.io/<token>', example: 'stripe' },
  lever: { label: 'Lever', tokenHint: 'jobs.lever.co/<token>', example: 'palantir' },
  ashby: { label: 'Ashby', tokenHint: 'jobs.ashbyhq.com/<token>', example: 'notion' },
  smartrecruiters: { label: 'SmartRecruiters', tokenHint: 'jobs.smartrecruiters.com/<token>', example: 'Ubisoft2' },
  workable: { label: 'Workable', tokenHint: 'apply.workable.com/<token>', example: 'huggingface' },
  recruitee: { label: 'Recruitee', tokenHint: '<token>.recruitee.com', example: 'bunq' },
  breezy: { label: 'Breezy HR', tokenHint: '<token>.breezy.hr', example: 'breezy' },
  personio: { label: 'Personio', tokenHint: '<token>.jobs.personio.de', example: 'personio' },
  workday: { label: 'Workday', tokenHint: '<tenant>/wd<N>/<site> from <tenant>.wd<N>.myworkdayjobs.com/<site>', example: 'nvidia/wd5/NVIDIAExternalCareerSite' },
  keka: { label: 'Keka', tokenHint: '<token>.keka.com/careers', example: 'evolve' },
  zoho: { label: 'Zoho Recruit', tokenHint: 'careers host, e.g. <company>.zohorecruit.in', example: 'airpay.zohorecruit.com' },
  freshteam: { label: 'Freshteam', tokenHint: '<token>.freshteam.com/jobs', example: 'digitap' },
  oracle: { label: 'Oracle Recruiting Cloud', tokenHint: '<host>|<siteNumber> from …/hcmUI/CandidateExperience/en/sites/<siteNumber>', example: 'jpmc.fa.oraclecloud.com|CX_1001' },
  successfactors: { label: 'SAP SuccessFactors', tokenHint: 'careers host whose /services/rss/job/ answers', example: 'careers.wipro.com' },
  sarkari: { label: 'Government notices', tokenHint: 'rr:all (RojgarResult) or a SarkariNaukri category slug: all, psu-jobs, banking-jobs, railway-jobs, ssc…', example: 'rr:all' },
  custom: { label: 'Custom JSON API', tokenHint: 'any name; replaces {token} in the URL', example: 'acme' },
};

export const isAtsType = (v: string): v is AtsType => v in SOURCES;

/** Recognise a board from a careers/job URL (used when users paste links). */
export function detectBoard(url: string): { atsType: AtsType; token: string } | null {
  try {
    const u = new URL(url);
    const seg = u.pathname.split('/').filter(Boolean);
    if (/(^|\.)greenhouse\.io$/.test(u.hostname)) {
      const token = u.hostname.startsWith('boards-api') ? seg[2] : seg[0];
      return token ? { atsType: 'greenhouse', token } : null;
    }
    if (u.hostname === 'jobs.lever.co' && seg[0]) return { atsType: 'lever', token: seg[0] };
    if (u.hostname === 'jobs.ashbyhq.com' && seg[0]) return { atsType: 'ashby', token: seg[0] };
    if (u.hostname === 'jobs.smartrecruiters.com' && seg[0]) return { atsType: 'smartrecruiters', token: seg[0] };
    if (u.hostname === 'apply.workable.com' && seg[0]) return { atsType: 'workable', token: seg[0] };
    const bz = u.hostname.match(/^([a-z0-9-]+)\.breezy\.hr$/);
    if (bz && bz[1] !== 'www') return { atsType: 'breezy', token: bz[1] };
    const pn = u.hostname.match(/^([a-z0-9-]+)\.jobs\.personio\.(?:de|com)$/);
    if (pn) return { atsType: 'personio', token: pn[1] };
    const rc = u.hostname.match(/^([a-z0-9-]+)\.recruitee\.com$/);
    if (rc) return { atsType: 'recruitee', token: rc[1] };
    const kk = u.hostname.match(/^([a-z0-9-]+)\.keka\.com$/);
    if (kk && kk[1] !== 'www' && seg[0] === 'careers') return { atsType: 'keka', token: kk[1] };
    if (/\.zohorecruit\.[a-z.]+$/.test(u.hostname) && seg[0] === 'jobs') return { atsType: 'zoho', token: u.hostname };
    const ft = u.hostname.match(/^([a-z0-9-]+)\.freshteam\.com$/);
    if (ft && seg[0] === 'jobs') return { atsType: 'freshteam', token: ft[1] };
    // …/hcmUI/CandidateExperience/<lang>/sites/<siteNumber>/…
    const oc = u.pathname.match(/\/hcmUI\/CandidateExperience\/[a-z-]+\/sites\/([A-Za-z0-9_]+)/i);
    if (oc && /oraclecloud\.com$/.test(u.hostname)) return { atsType: 'oracle', token: `${u.hostname}|${oc[1]}` };
    // <tenant>.wd5.myworkdayjobs.com/[en-US/]<site>/job/...
    const wd = u.hostname.match(/^([a-z0-9-]+)\.(wd\d+)\.myworkdayjobs\.com$/i);
    if (wd) {
      const site = /^[a-z]{2}-[A-Z]{2}$/.test(seg[0] ?? '') ? seg[1] : seg[0];
      return site ? { atsType: 'workday', token: `${wd[1].toLowerCase()}/${wd[2].toLowerCase()}/${site}` } : null;
    }
  } catch {
    /* not a URL */
  }
  return null;
}
