// ============================================================
// JOB NORMALIZATION — rules only, zero AI tokens.
// ============================================================

export const SKILL_WORDS = [
  'JavaScript', 'TypeScript', 'Python', 'Java', 'Kotlin', 'Swift', 'Go', 'Golang', 'Rust', 'C++', 'C#', 'PHP', 'Ruby', 'Dart', 'Scala',
  'React', 'Next.js', 'Angular', 'Vue', 'Svelte', 'Node.js', 'Express', 'NestJS', 'Django', 'Flask', 'FastAPI', 'Spring Boot', 'Spring',
  'Flutter', 'React Native', 'Android', 'iOS', 'HTML', 'CSS', 'Tailwind', 'Redux', 'GraphQL', 'REST', 'gRPC', 'Microservices',
  'SQL', 'PostgreSQL', 'MySQL', 'MongoDB', 'Redis', 'Firebase', 'Supabase', 'Elasticsearch', 'Kafka', 'RabbitMQ', 'Snowflake', 'Spark',
  'AWS', 'GCP', 'Azure', 'Docker', 'Kubernetes', 'Terraform', 'Linux', 'Git', 'CI/CD', 'Jenkins', 'GitHub Actions',
  'Machine Learning', 'Deep Learning', 'TensorFlow', 'PyTorch', 'Pandas', 'NumPy', 'scikit-learn', 'LLM', 'NLP', 'Computer Vision',
  'Excel', 'Power BI', 'Tableau', 'Figma', 'Jira', 'Agile', 'Scrum', 'Playwright', 'Selenium', 'Jest', 'Cypress',
  'Product Management', 'Data Analysis', 'Salesforce', 'SAP', 'Marketing', 'SEO', 'Sales', 'Customer Success',
];

const SKILL_PATTERNS = SKILL_WORDS.map((s) => ({
  skill: s,
  re: new RegExp(`(^|[^a-z0-9])${s.toLowerCase().replace(/[.+#/]/g, (c) => `\\${c}`)}([^a-z0-9]|$)`),
}));

export function extractSkills(text: string, limit = 25): string[] {
  const lower = text.toLowerCase();
  const found: string[] = [];
  for (const { skill, re } of SKILL_PATTERNS) {
    if (re.test(lower)) found.push(skill);
    if (found.length >= limit) break;
  }
  return found;
}

export function htmlToText(html: string): string {
  return html
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/<(br|\/p|\/li|\/h\d|\/div)\s*\/?>/gi, '\n')
    .replace(/<li[^>]*>/gi, '• ')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n\s*\n+/g, '\n\n')
    .trim();
}

export type Workplace = 'Remote' | 'Hybrid' | 'On-site';

export function detectWorkplace(...hints: Array<string | boolean | null | undefined>): Workplace | null {
  const text = hints.filter((h) => typeof h === 'string').join(' ').toLowerCase();
  if (hints.includes(true)) return 'Remote';
  if (/\bhybrid\b/.test(text)) return 'Hybrid';
  if (/\bremote\b|work from home|\bwfh\b|anywhere/.test(text)) return 'Remote';
  if (/on-?site|in-?office|onsite/.test(text)) return 'On-site';
  return null;
}

const INDIA = new RegExp(
  '\\b(' +
    [
      'india', 'bharat',
      // metros and IT hubs
      'bengaluru', 'bangalore', 'hyderabad', 'secunderabad', 'pune', 'hinjewadi', 'mumbai', 'navi mumbai', 'thane', 'delhi', 'new delhi',
      'delhi ncr', 'ncr', 'gurugram', 'gurgaon', 'noida', 'greater noida', 'ghaziabad', 'faridabad', 'chennai', 'kolkata', 'ahmedabad',
      'gandhinagar', 'jaipur', 'kochi', 'cochin', 'lucknow', 'chandigarh', 'mohali', 'panchkula', 'indore', 'coimbatore', 'trivandrum',
      'thiruvananthapuram', 'mysuru', 'mysore', 'mangaluru', 'mangalore', 'hubli', 'bhubaneswar', 'nagpur', 'nashik', 'aurangabad',
      'vadodara', 'surat', 'rajkot', 'visakhapatnam', 'vizag', 'vijayawada', 'madurai', 'tiruchirappalli', 'trichy', 'salem', 'vellore',
      'bhopal', 'raipur', 'ranchi', 'jamshedpur', 'patna', 'guwahati', 'dehradun', 'udaipur', 'jodhpur', 'goa', 'panaji', 'sanand',
      // states
      'karnataka', 'maharashtra', 'telangana', 'tamil nadu', 'tamilnadu', 'haryana', 'uttar pradesh', 'gujarat', 'kerala',
      'west bengal', 'rajasthan', 'punjab', 'madhya pradesh', 'odisha', 'andhra pradesh', 'jharkhand', 'chhattisgarh', 'assam',
      'uttarakhand', 'bihar',
    ].join('|') +
    ')\\b',
  'i',
);
// "Pune, MH, IN" — an Indian state code before "IN" (a bare ", IN" is Indiana).
const INDIA_CODES = /\b(KA|MH|TN|TS|TG|DL|HR|UP|GJ|KL|WB|RJ|AP|PB|MP|OD|OR|CH|GA)\s*,\s*(IN|IND)\b|\bIND\b/;
const USA_NAMES = /\b(united states|usa|u\.s\.a?\.?|new york|san francisco|seattle|austin|boston|chicago|los angeles|denver|atlanta|miami|washington,? d\.?c\.?|bay area|us remote|remote\s*[-,]\s*us|alabama|alaska|arizona|arkansas|california|colorado|connecticut|delaware|florida|georgia|hawaii|idaho|illinois|indiana|iowa|kansas|kentucky|louisiana|maine|maryland|massachusetts|michigan|minnesota|mississippi|missouri|montana|nebraska|nevada|new hampshire|new jersey|new mexico|north carolina|north dakota|ohio|oklahoma|oregon|pennsylvania|rhode island|south carolina|south dakota|tennessee|texas|utah|vermont|virginia|wisconsin|wyoming)\b/i;
// State codes and a bare "US" are only meaningful in upper case ("Austin, TX", "Remote US").
const USA_CODES = /\bUS\b|,\s*(AL|AK|AZ|AR|CA|CO|CT|DE|FL|GA|HI|ID|IL|IN|IA|KS|KY|LA|ME|MD|MA|MI|MN|MS|MO|MT|NE|NV|NH|NJ|NM|NY|NC|ND|OH|OK|OR|PA|RI|SC|SD|TN|TX|UT|VT|VA|WA|WV|WI|WY)\b/;
const OTHER: Array<[RegExp, string]> = [
  [/\b(united kingdom|london|uk|england|manchester)\b/i, 'GB'],
  [/\b(canada|toronto|vancouver|montreal)\b/i, 'CA'],
  [/\b(germany|berlin|munich)\b/i, 'DE'],
  [/\b(singapore)\b/i, 'SG'],
  [/\b(ireland|dublin)\b/i, 'IE'],
  [/\b(netherlands|amsterdam)\b/i, 'NL'],
  [/\b(france|paris)\b/i, 'FR'],
  [/\b(australia|sydney|melbourne)\b/i, 'AU'],
  [/\b(uae|dubai|abu dhabi)\b/i, 'AE'],
  [/\b(brazil|brasil|são paulo|sao paulo)\b/i, 'BR'],
  [/\b(mexico|méxico)\b/i, 'MX'],
  [/\b(spain|madrid|barcelona)\b/i, 'ES'],
  [/\b(poland|warsaw|krakow|kraków)\b/i, 'PL'],
  [/\b(portugal|lisbon)\b/i, 'PT'],
  [/\b(japan|tokyo)\b/i, 'JP'],
  [/\b(israel|tel aviv)\b/i, 'IL'],
  [/\b(argentina|buenos aires)\b/i, 'AR'],
  [/\b(colombia|bogot[aá])\b/i, 'CO'],
  [/\b(philippines|manila)\b/i, 'PH'],
  [/\b(sweden|stockholm)\b/i, 'SE'],
  [/\b(switzerland|zurich|zürich)\b/i, 'CH'],
];

export function detectCountry(location: string | null | undefined): string | null {
  if (!location) return null;
  if (INDIA.test(location) || INDIA_CODES.test(location)) return 'IN';
  if (USA_NAMES.test(location) || USA_CODES.test(location)) return 'US';
  for (const [re, code] of OTHER) if (re.test(location)) return code;
  return null;
}

export function detectSeniority(title: string): string | null {
  const t = title.toLowerCase();
  if (/\bintern(ship)?\b|\btrainee\b|\bapprentice\b/.test(t)) return 'intern';
  if (/\b(new grad|graduate|fresher|entry[- ]level|junior|jr\.?|associate)\b/.test(t)) return 'entry';
  if (/\b(principal|staff|distinguished|fellow)\b/.test(t)) return 'staff';
  if (/\b(director|vp|vice president|head of|chief)\b/.test(t)) return 'executive';
  if (/\b(manager|lead|architect)\b/.test(t)) return 'lead';
  // Banking grades (AVP = assistant vice-president) and Indian "SDE 3"/"Level 3".
  if (/\b(senior|sr\.?|sde ?(iii|3)|level ?3|avp|assistant vice president)\b/.test(t)) return 'senior';
  return 'mid';
}

/** Reject impossible dates (future, or before 2000) instead of showing nonsense. */
export function validDate(value: string | number | null | undefined): Date | null {
  if (value === null || value === undefined || value === '') return null;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  const now = Date.now();
  if (d.getTime() > now + 24 * 3600_000) return null;
  if (d.getFullYear() < 2000) return null;
  return d;
}

export interface NormalizedJob {
  externalId: string;
  title: string;
  url: string;
  location: string | null;
  country: string | null;
  workplace: Workplace | null;
  employmentType: string | null;
  department: string | null;
  postedAt: Date | null;
  description: string;
  skills: string[];
  seniority: string | null;
  salaryMin: number | null;
  salaryMax: number | null;
  salaryCurrency: string | null;
  salaryPeriod: string | null;
  /** Years of experience the job asks for (from the system, or read from the text). */
  experienceMin?: number | null;
  experienceMax?: number | null;
  /** The employer, when a board lists several (a news feed of government notices). */
  company?: string;
  /** Application deadline and head-count, when the notice states them. */
  closesAt?: Date | null;
  vacancies?: number | null;
  /**
   * Listing-only row for a job we already have (its details weren't fetched
   * again): the poller keeps the stored description/skills/location.
   */
  partial?: boolean;
}

/** "2-5 years", "3+ yrs of experience", "minimum 4 years" → years asked for. */
export function experienceFromText(text: string): { min: number | null; max: number | null } {
  const t = text.toLowerCase().slice(0, 8000);
  // Only plausible asks (≤ 30 years): "a legacy of 85 years" isn't one.
  const ok = (n: number) => n >= 0 && n <= 30;
  const range = t.match(/(\d{1,2})\s*(?:-|–|to)\s*(\d{1,2})\s*\+?\s*(?:years?|yrs?)\b/);
  if (range && ok(Number(range[1])) && ok(Number(range[2])) && Number(range[2]) >= Number(range[1])) {
    return { min: Number(range[1]), max: Number(range[2]) };
  }
  const min = t.match(/(?:minimum|min\.?|at least)\s*(?:of\s*)?(\d{1,2})\s*\+?\s*(?:years?|yrs?)|(\d{1,2})\s*\+\s*(?:years?|yrs?)\s*(?:of\s*)?(?:\w+\s*){0,2}experience|(\d{1,2})\s*(?:years?|yrs?)\s*(?:of\s*)?(?:relevant\s*|professional\s*|hands[- ]on\s*|industry\s*|work\s*)?experience|experience\s*(?:required)?\s*:?\s*(\d{1,2})\s*\+?\s*(?:years?|yrs?)/);
  const n = min ? Number(min[1] ?? min[2] ?? min[3] ?? min[4]) : NaN;
  if (min && ok(n)) return { min: n, max: null };
  if (/\bfreshers?\b|\b0\s*(?:years?|yrs?)\b|no experience required/.test(t)) return { min: 0, max: 1 };
  return { min: null, max: null };
}

/** One name per Indian city ("Bangalore" → "Bengaluru"), so lists and filters don't split. */
const CITY_NAMES: [RegExp, string][] = [
  [/\bbangalore\b/gi, 'Bengaluru'], [/\bgurgaon\b/gi, 'Gurugram'], [/\bbombay\b/gi, 'Mumbai'], [/\bmadras\b/gi, 'Chennai'],
  [/\bcalcutta\b/gi, 'Kolkata'], [/\bcochin\b/gi, 'Kochi'], [/\btrivandrum\b/gi, 'Thiruvananthapuram'], [/\bmysore\b/gi, 'Mysuru'],
  [/\bmangalore\b/gi, 'Mangaluru'], [/\bvizag\b/gi, 'Visakhapatnam'],
];
export function canonicalLocation(location: string | null): string | null {
  if (!location) return location;
  let out = location;
  for (const [re, name] of CITY_NAMES) out = out.replace(re, name);
  return out;
}

export function finalize(j: Omit<NormalizedJob, 'country' | 'skills' | 'seniority'> & { country?: string | null }): NormalizedJob {
  const description = j.description.slice(0, 20_000);
  const exp = (j.experienceMin ?? null) !== null || (j.experienceMax ?? null) !== null
    ? { min: j.experienceMin ?? null, max: j.experienceMax ?? null }
    : experienceFromText(`${j.title}\n${description}`);
  return {
    ...j,
    location: canonicalLocation(j.location),
    experienceMin: exp.min,
    experienceMax: exp.max,
    country: j.country ?? detectCountry(j.location),
    skills: extractSkills(`${j.title}\n${description}`),
    seniority: detectSeniority(j.title),
    description,
  };
}
