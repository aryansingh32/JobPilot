import { finalize, htmlToText, type NormalizedJob } from './normalize.js';

// ============================================================
// SARKARINAUKRI.COM — government recruitment notices.
// The site is WordPress and publishes its REST API (robots.txt allows all).
// Posts are prose, not structured jobs, so this reads out what a candidate
// needs: who is hiring, the closing date, the official site to apply on.
// A board token is a category slug ("psu-jobs") or "all".
// ============================================================

const BASE = 'https://sarkarinaukri.com';

/**
 * Where notices come from. A board token is a category slug of the default source, or "<source>:all".
 * sarkarinaukri.com's own feed stopped publishing in Oct 2025 (every notice looked a year old); rojgarresult.com
 * is a second live WordPress source whose robots.txt allows search use. It mixes results and admit cards in with
 * recruitment notices, so only application notices with an official apply link are kept.
 */
const SOURCES: Record<string, { base: string; selfHost: string; label: string; onlyApplicationNotices: boolean }> = {
  sn: { base: BASE, selfHost: 'sarkarinaukri\\.com', label: 'SarkariNaukri', onlyApplicationNotices: false },
  rr: { base: 'https://rojgarresult.com', selfHost: 'rojgarresult\\.com', label: 'RojgarResult', onlyApplicationNotices: true },
};

const NOT_AN_APPLICATION = /\b(result|admit card|answer key|exam city|city details|syllabus|marks|cut[\s-]?off|score\s?card|merit list|document verification|interview (schedule|date)|call letter|hall ticket|selection list|final list|scheme|yojna|yojana|expected)\b/i;
const IS_APPLICATION = /\b(online form|apply online|recruitment|vacanc|walk-?in|notification|application form|bharti)\b/i;

/** Results and admit cards are not jobs to apply for. */
export function isApplicationNotice(title: string): boolean {
  return IS_APPLICATION.test(title) && !NOT_AN_APPLICATION.test(title);
}
const UA = 'jobpilot-jobs/1.0 (+https://jobpilot.app)';

/** WordPress category ids under "Job news" (verified against /wp-json/wp/v2/categories). */
export const SARKARI_CATEGORIES: Record<string, { id: number; label: string }> = {
  all: { id: 8, label: 'All government jobs' },
  'india-govt-jobs': { id: 10, label: 'Central government' },
  'psu-jobs': { id: 15, label: 'PSU' },
  'banking-jobs': { id: 14, label: 'Banking' },
  'railway-jobs': { id: 12, label: 'Railways' },
  'defence-jobs': { id: 26, label: 'Defence' },
  'psc-jobs': { id: 18, label: 'Public Service Commissions' },
  'education-jobs': { id: 24, label: 'Education' },
  'engineering-jobs': { id: 21, label: 'Engineering' },
  'state-jobs': { id: 792, label: 'State government' },
  ssc: { id: 2343, label: 'SSC' },
};

/** WordPress state categories (parent "states-ut") → state names, for location. */
const STATE_BY_CATEGORY: Record<number, string> = {
  58: 'Andaman & Nicobar', 29: 'Andhra Pradesh', 31: 'Arunachal Pradesh', 32: 'Assam', 33: 'Bihar', 59: 'Chandigarh',
  34: 'Chhattisgarh', 60: 'Daman & Diu', 61: 'Delhi', 35: 'Goa', 36: 'Gujarat', 37: 'Haryana', 38: 'Himachal Pradesh',
  62: 'Jammu & Kashmir', 39: 'Jharkhand', 40: 'Karnataka', 41: 'Kerala', 63: 'Ladakh', 64: 'Lakshadweep', 42: 'Madhya Pradesh',
  43: 'Maharashtra', 44: 'Manipur', 45: 'Meghalaya', 46: 'Mizoram', 47: 'Nagaland', 48: 'Odisha', 65: 'Puducherry',
  49: 'Punjab', 50: 'Rajasthan', 51: 'Sikkim', 52: 'Tamil Nadu', 53: 'Telangana', 54: 'Tripura', 56: 'Uttar Pradesh',
  55: 'Uttarakhand', 57: 'West Bengal',
};

export interface SarkariPost {
  id: number;
  date: string;
  modified?: string;
  link: string;
  title: { rendered: string };
  content: { rendered: string };
  categories: number[];
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

function ymd(y: number, m: number, d: number): Date | null {
  if (y < 100) y += 2000;
  const date = new Date(Date.UTC(y, m, d, 18, 29, 59)); // 23:59:59 IST
  return date.getUTCMonth() === m && date.getUTCDate() === d ? date : null;
}

/** "31.10.2025", "20th October 2025", "October 31, 2025" → that day, end of day IST. */
export function parseIndianDate(s: string): Date | null {
  const t = s.trim().replace(/(\d)(st|nd|rd|th)\b/gi, '$1');
  let m = t.match(/^(\d{1,2})[./-](\d{1,2})[./-](\d{2,4})$/);
  if (m) return ymd(Number(m[3]), Number(m[2]) - 1, Number(m[1]));
  m = t.match(/^(\d{1,2})[\s-]+([A-Za-z]{3,9})[\s,.-]+(\d{2,4})$/);
  if (m) {
    const mo = MONTHS.indexOf(m[2].slice(0, 3).toLowerCase());
    return mo >= 0 ? ymd(Number(m[3]), mo, Number(m[1])) : null;
  }
  m = t.match(/^([A-Za-z]{3,9})\s+(\d{1,2}),?\s+(\d{4})$/);
  if (m) {
    const mo = MONTHS.indexOf(m[1].slice(0, 3).toLowerCase());
    return mo >= 0 ? ymd(Number(m[3]), mo, Number(m[2])) : null;
  }
  return null;
}

const DATE = String.raw`(\d{1,2}(?:st|nd|rd|th)?[\s./-]+(?:[A-Za-z]{3,9}|\d{1,2})[\s./,-]+\d{2,4}|[A-Z][a-z]{2,8}\s+\d{1,2}(?:st|nd|rd|th)?,?\s+\d{4})`;
const CLOSING = new RegExp(
  String.raw`(?:last\s+date|closing\s+date|last\s+day|deadline|apply\s+(?:online\s+)?(?:by|before|till|until)|on\s+or\s+before)[^.\n]{0,90}?${DATE}`,
  'i',
);

/** The application deadline, when the notice states one. */
export function closingDate(text: string): Date | null {
  const m = text.match(CLOSING);
  return m ? parseIndianDate(m[1].replace(/(\d)(st|nd|rd|th)\b/gi, '$1')) : null;
}

/** "340 Probationary Engineer Positions" → 340. */
export function vacancyCount(title: string, text: string): number | null {
  const t = title.match(/\b(\d[\d,]*)\s+(?:[A-Za-z-]+\s+){0,4}?(?:posts?|positions?|vacanc|apprentices?|engineers?|officers?|clerks?|teachers?|inspectors?|trade|faculty|constables?|managers?)/i);
  const m = t ?? text.slice(0, 3000).match(/total\s+(?:of\s+)?(\d[\d,]*)\s+(?:vacanc|posts?|positions?)/i);
  const n = m ? Number(m[1].replace(/,/g, '')) : NaN;
  return n > 0 && n < 500_000 ? n : null;
}

/** The hiring organisation: the words before "Announces/Invites/Recruitment…" in the headline. */
export function hiringOrg(title: string): string {
  const t = title.replace(/&#8211;|&#8217;|&amp;/g, (e) => (e === '&amp;' ? '&' : e === '&#8217;' ? "'" : '-')).trim();
  const m = t.match(/^(.{2,70}?)\s+(?:announces?|invites?|notif(?:ies|ication)|releases?|recruitment|recruits?|opens?|inviting|calls?|seeks?|to\s+recruit|walk-?in|advertises?|extends?|hiring)\b/i);
  return (m ? m[1] : t.split(/\s+[-–:|]\s+/)[0]).replace(/\s+/g, ' ').trim().slice(0, 70);
}

/** The role in a notice: what follows "for N" in the headline, or the headline minus the employer. */
export function roleFromTitle(title: string): string {
  const t = title.replace(/&#8211;|&#8217;/g, "'").replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();
  const clean = (v: string) => v.replace(/\s+(?:posts?|positions?|vacancies|on contract basis)\b.*$/i, '').replace(/^[\d,+\s]+/, '').trim();
  const words = (v: string) => (/^(posts?|positions?|vacancies|professionals?)$/i.test(v) ? 0 : (v.match(/[A-Za-z]{3,}/g) ?? []).length);
  const m = t.match(/\bfor\s+(?:the\s+)?(?:\d[\d,+]*\s+)?(.{3,80})$/i);
  const forRole = m ? clean(m[1]) : '';
  if (words(forRole) >= 1 && forRole.length >= 4) return forRole;
  const rest = clean(t.replace(/^.{2,70}?\s+(?:announces?|invites?|seeks?|releases?|recruits?|opens?|calls?)\s+(?:applications?\s+)?(?:for\s+|recruitment\s+(?:for\s+)?)?/i, ''));
  return words(rest) >= 1 && rest.length >= 4 ? rest : t;
}

/** The employer's own site: an "Apply online / Official website" link first, else the first outbound link that is not a news or social page. */
export function officialLink(html: string, selfHost = 'sarkarinaukri\\.com'): string | null {
  const BLOCK = new RegExp(`(${selfHost}|facebook\\.com|twitter\\.com|x\\.com|instagram\\.com|youtube\\.com|youtu\\.be|tinyurl\\.com|bit\\.ly|sarkariresult\\.com|sarkarinaukri\\.com|rojgarresult\\.com|t\\.me|whatsapp\\.com|telegram\\.|linkedin\\.com|google\\.com|wikipedia\\.org|w\\.org)`, 'i');
  const anchors = [...html.matchAll(/<a\b[^>]*href="(https?:\/\/[^"#]+)"[^>]*>([\s\S]*?)<\/a>/gi)]
    .map((m) => ({ url: m[1], text: m[2].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim() }))
    .filter((a) => !BLOCK.test(a.url) && !/\.(jpe?g|png|gif|webp)(\?|$)/i.test(a.url));
  const isPdf = (u: string) => /\.pdf(\?|$)/i.test(u);
  // A notification PDF is evidence, not the place to apply: prefer a portal.
  const says = anchors.find((a) => /apply\s*online|online\s*(application|form)|official\s*web\s*site|registration|click here to apply/i.test(a.text) && !isPdf(a.url));
  return (says ?? anchors.find((a) => !isPdf(a.url)) ?? anchors[0])?.url ?? null;
}

/** Which kind of portal the application happens on — picks the apply workflow. */
export function portalKind(url: string | null): string {
  const host = (() => {
    try {
      return new URL(url ?? '').hostname.toLowerCase();
    } catch {
      return '';
    }
  })();
  if (/ssc\.(gov|nic)\.in/.test(host)) return 'ssc';
  if (/upsc\.gov\.in|upsconline/.test(host)) return 'upsc';
  if (/ibps\.in|sbi\.co\.in|bank|rbi\.org/.test(host)) return 'bank';
  if (/rrb|indianrailways|rrcb|irctc/.test(host)) return 'railway';
  if (/psc|bpsc|uppsc|mpsc|tnpsc|kpsc|hpsc|rpsc/.test(host)) return 'psc';
  if (/\.(gov|nic)\.in$/.test(host)) return 'gov';
  return 'psu';
}

function stateOf(categories: number[]): string | null {
  for (const c of categories) if (STATE_BY_CATEGORY[c]) return STATE_BY_CATEGORY[c];
  return null;
}

/** Posts without a stated deadline stay listed this long after they were published. */
const UNDATED_LIFETIME_DAYS = 45;

/** One notice → one job, or null when it has closed or can't be applied to. */
export function postToJob(p: SarkariPost, now = new Date(), source: keyof typeof SOURCES = 'sn'): NormalizedJob | null {
  const src = SOURCES[source];
  const title = htmlToText(p.title.rendered).replace(/\s+/g, ' ').trim();
  // Aggregators also publish results and admit cards — nothing to apply to.
  if (src.onlyApplicationNotices && !isApplicationNotice(title)) return null;
  const text = htmlToText(p.content.rendered);
  const posted = new Date(`${p.date}+05:30`);
  const closes = closingDate(text);
  const open = closes ? closes.getTime() >= now.getTime() : now.getTime() - posted.getTime() < UNDATED_LIFETIME_DAYS * 86_400_000;
  if (!open) return null;
  const official = officialLink(p.content.rendered, src.selfHost);
  // An aggregator's own page is not a form: without the employer's link there is nothing to apply on.
  if (src.onlyApplicationNotices && !official) return null;
  const applyUrl = official ?? p.link;
  const vacancies = vacancyCount(title, text);
  const org = hiringOrg(title);
  const state = stateOf(p.categories);
  const header = [
    closes ? `Last date to apply: ${closes.toLocaleDateString('en-IN', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Asia/Kolkata' })}` : null,
    vacancies ? `Vacancies: ${vacancies}` : null,
    `Apply on: ${applyUrl}`,
    `Portal: ${portalKind(applyUrl)}`,
    `Notice: ${p.link}`,
  ].filter(Boolean).join('\n');
  return {
    ...finalize({
      externalId: String(p.id),
      title: roleFromTitle(title) || title,
      url: applyUrl,
      location: state ?? 'India',
      country: 'IN',
      workplace: 'On-site',
      employmentType: 'Government',
      department: org,
      postedAt: posted,
      description: `${header}\n\n${text}`,
      salaryMin: null, salaryMax: null, salaryCurrency: null, salaryPeriod: null,
      // Government notices state age/qualification, not years of experience.
      experienceMin: null,
      experienceMax: null,
    }),
    company: org,
    closesAt: closes,
    vacancies,
  };
}

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url, { headers: { 'user-agent': UA, accept: 'application/json' }, signal: AbortSignal.timeout(45_000) });
  if (res.status === 404 || res.status === 400) throw Object.assign(new Error('Category not found'), { code: 'BOARD_NOT_FOUND' });
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${new URL(url).hostname}`);
  return res.json() as Promise<T>;
}

export interface SarkariResult {
  company?: string;
  jobs: NormalizedJob[];
  complete: boolean;
  /** When the source last published anything (open or not): how a dead feed is told from a quiet one. */
  newestPostAt: Date | null;
}

/**
 * Latest notices in a category (or "<source>:all"). The newest 100 cover weeks of activity even
 * for the busiest feed, and a notice that stays open is re-listed each poll.
 */
export async function sarkari(token: string): Promise<SarkariResult> {
  const [prefix, rest] = token.includes(':') ? (token.split(':') as [string, string]) : ['sn', token];
  const source = SOURCES[prefix] ? prefix : null;
  if (!source) throw Object.assign(new Error(`Unknown source "${prefix}"`), { code: 'BOARD_NOT_FOUND' });
  const cat = source === 'sn' ? SARKARI_CATEGORIES[rest] : { id: 0, label: SOURCES[source].label };
  if (!cat || (source !== 'sn' && rest !== 'all')) throw Object.assign(new Error(`Unknown category "${token}"`), { code: 'BOARD_NOT_FOUND' });
  const filter = source === 'sn' ? `&categories=${cat.id}` : '';
  const posts = await getJson<SarkariPost[]>(
    `${SOURCES[source].base}/wp-json/wp/v2/posts?per_page=100&orderby=date&order=desc${filter}&_fields=id,date,modified,link,title,content,categories`,
  );
  const now = new Date();
  const jobs = posts.map((p) => postToJob(p, now, source)).filter((j): j is NormalizedJob => j !== null);
  const newest = posts[0]?.date ? new Date(`${posts[0].date}+05:30`) : null;
  // Closed notices are left out on purpose: complete lets the poller mark them closed.
  return { company: `Government jobs · ${cat.label}`, jobs, complete: true, newestPostAt: newest };
}
