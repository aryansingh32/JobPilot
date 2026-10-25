import type { ProfileData } from './index.js';

// ============================================================
// RESUME SECTIONS — rules for work history and education (no AI).
// Finds the "Experience" / "Education" headings, then reads each entry from
// its date line: "Software Engineer, Acme — San Francisco, CA — Jun 2023 – Present".
// Used on its own when no model is configured, and to fill gaps otherwise.
// ============================================================

type Experience = NonNullable<ProfileData['experience']>[number];
type Education = NonNullable<ProfileData['education']>[number];

const MONTHS: Record<string, string> = {
  jan: '01', feb: '02', mar: '03', apr: '04', may: '05', jun: '06', jul: '07', aug: '08', sep: '09', sept: '09', oct: '10', nov: '11', dec: '12',
};
const MONTH = '(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\\.?';
const POINT = `(?:${MONTH}\\s+\\d{4}|\\d{1,2}/\\d{4}|\\d{4})`;
const RANGE = new RegExp(`(${POINT})\\s*(?:[-–—]|to)\\s*(${POINT}|present|current|now|today)`, 'i');

const HEADINGS: Record<'experience' | 'education' | 'other', RegExp> = {
  experience: /^(work|professional|relevant)?\s*(experience|employment( history)?|work history|career history)$/i,
  education: /^(education|academics?|academic background|qualifications)$/i,
  other: /^(skills|technical skills|projects|personal projects|certifications?|awards|achievements|publications|summary|profile|objective|interests|languages|volunteer(ing)?|activities|references)$/i,
};

const ROLE_WORDS =
  /\b(engineer|developer|programmer|manager|analyst|intern|designer|scientist|lead|consultant|architect|specialist|associate|administrator|director|officer|technician|researcher|assistant|coordinator|executive|head|founder|sde|swe)\b/i;
const DEGREE = /\b(b\.?\s?s\.?c?|b\.?\s?tech|b\.?\s?e\.?|b\.?\s?a\.?|bachelor'?s?|m\.?\s?s\.?c?|m\.?\s?tech|m\.?\s?e\.?|m\.?\s?a\.?|master'?s?|mba|ph\.?\s?d|doctorate|diploma|associate'?s? degree|b\.?com|m\.?com|bca|mca|high school|hsc|ssc|class (x|xii))(?![a-z])/i;
const SCHOOL = /\b(university|college|institute|school|academy|iit|nit|iiit|polytechnic)\b/i;
const PLACE = /^([Rr]emote|[A-Z][a-z]+(?:\s[A-Z][a-z]+)*,\s*[A-Z]{2,}(?:,\s*[A-Z][A-Za-z]+)?|[A-Z][a-z]+(?:\s[A-Z][a-z]+)*,\s*(?:India|USA|United States|UK|Canada))$/;

function toYm(p: string): string | undefined {
  const s = p.trim().toLowerCase();
  if (/present|current|now|today/.test(s)) return undefined;
  const m = s.match(/^([a-z]+)\.?\s+(\d{4})$/);
  if (m) {
    const mm = MONTHS[m[1].startsWith('sept') ? 'sept' : m[1].slice(0, 3)];
    return mm ? `${m[2]}-${mm}` : m[2];
  }
  const n = s.match(/^(\d{1,2})\/(\d{4})$/);
  if (n) return `${n[2]}-${n[1].padStart(2, '0')}`;
  return /^\d{4}$/.test(s) ? s : undefined;
}

/** Lines of each section, keyed by kind (text before the first heading is ignored). */
function sections(text: string): Record<'experience' | 'education', string[]> {
  const out: Record<'experience' | 'education', string[]> = { experience: [], education: [] };
  let current: 'experience' | 'education' | 'other' | null = null;
  for (const raw of text.split('\n')) {
    const line = raw.replace(/\s+/g, ' ').trim();
    if (!line) continue;
    const heading = line.replace(/[:•|]+$/, '').trim();
    const kind = (Object.keys(HEADINGS) as (keyof typeof HEADINGS)[]).find((k) => heading.length < 40 && HEADINGS[k].test(heading));
    if (kind) {
      current = kind;
      continue;
    }
    if (current === 'experience' || current === 'education') out[current].push(line);
  }
  return out;
}

/** "Title, Company — Location" / "Company | Title" / "Title at Company" → parts. */
function splitHeader(s: string): { title?: string; company?: string; location?: string } {
  const parts = s
    .split(/\s+(?:—|–|-|\||·|•)\s+|,\s+(?=[A-Z])|\s+at\s+/)
    .map((p) => p.trim().replace(/^[,;:]|[,;:]$/g, '').trim())
    .filter(Boolean);
  const out: { title?: string; company?: string; location?: string } = {};
  // "San Francisco, CA" was split at the comma: put city + state back together.
  for (let i = 0; i < parts.length; i++) {
    const joined = i + 1 < parts.length ? `${parts[i]}, ${parts[i + 1]}` : '';
    if (!out.location && joined && PLACE.test(joined)) {
      out.location = joined;
      parts.splice(i, 2);
      i--;
    } else if (!out.location && PLACE.test(parts[i])) {
      out.location = parts[i];
      parts.splice(i, 1);
      i--;
    }
  }
  const titleIdx = parts.findIndex((p) => ROLE_WORDS.test(p));
  if (titleIdx >= 0) {
    out.title = parts[titleIdx];
    out.company = parts.find((_, i) => i !== titleIdx);
  } else {
    [out.company, out.title] = parts;
  }
  return out;
}

export function extractExperience(text: string): Experience[] {
  const lines = sections(text).experience;
  const entries: Experience[] = [];
  for (let i = 0; i < lines.length; i++) {
    const range = lines[i].match(RANGE);
    if (!range) continue;
    // The header is the date line itself, or the line above it when the dates sit alone.
    let header = lines[i].replace(RANGE, '').replace(/[\s,—–|-]+$/, '').trim();
    if (header.length < 3 && i > 0 && !RANGE.test(lines[i - 1])) header = lines[i - 1];
    const { title, company, location } = splitHeader(header);
    if (!title && !company) continue;
    const highlights: string[] = [];
    for (let j = i + 1; j < lines.length && highlights.length < 4; j++) {
      if (RANGE.test(lines[j]) || (j + 1 < lines.length && RANGE.test(lines[j + 1]) && lines[j + 1].replace(RANGE, '').trim().length < 3)) break;
      highlights.push(lines[j].replace(/^[•▪●◦\-*]\s*/, ''));
    }
    const current = /present|current|now|today/i.test(range[2]);
    entries.push({
      title: title ?? '',
      company: company ?? '',
      location,
      start: toYm(range[1]),
      end: current ? undefined : toYm(range[2]),
      current: current || undefined,
      highlights: highlights.length ? highlights : undefined,
    });
  }
  return entries.slice(0, 10);
}

export function extractEducation(text: string): Education[] {
  const out: Education[] = [];
  for (const line of sections(text).education) {
    if (!DEGREE.test(line) && !SCHOOL.test(line)) continue;
    const years = line.match(/\b(19|20)\d{2}\b/g) ?? [];
    const cleaned = line.replace(RANGE, '').replace(/\b(19|20)\d{2}\b/g, '').replace(/[\s,—–|-]+$/, '').trim();
    const parts = cleaned.split(/\s+(?:—|–|-|\||·)\s+|,\s+(?=[A-Z])/).map((p) => p.trim()).filter(Boolean);
    const at = parts.findIndex((p) => SCHOOL.test(p));
    // "University of California, Davis": a short place right after the school is part of its name.
    const campus = at >= 0 ? parts[at + 1] : undefined;
    const school =
      at < 0 ? '' : campus && /^[A-Z][a-z]+(?:\s[A-Z][a-z]+){0,2}$/.test(campus) && !DEGREE.test(campus) ? `${parts[at]}, ${campus}` : parts[at];
    const degreePart = parts.find((p) => DEGREE.test(p) && p !== school);
    // "B.S. Computer Science" → degree + field.
    const degreeMatch = degreePart?.match(DEGREE);
    const field = degreePart && degreeMatch ? degreePart.slice((degreeMatch.index ?? 0) + degreeMatch[0].length).replace(/^[\s.,]*(in\s+|of\s+)?/i, '').trim() : undefined;
    if (!school && !degreePart) continue;
    out.push({
      school,
      degree: degreeMatch?.[0],
      field: field || undefined,
      start: years.length > 1 ? years[0] : undefined,
      end: years.length ? years[years.length - 1] : undefined,
    });
  }
  return out.slice(0, 5);
}
