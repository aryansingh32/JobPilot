import type { ProfileData } from '../profile/index.js';
import { yearsOfExperience } from '../profile/years.js';
import { extractSkills } from './normalize.js';
import { cosine, stretchSimilarity, weightedCoverage, yearsFit } from './fit-math.js';

// ============================================================
// RÉSUMÉ vs ONE JOB. The match score ranks many jobs; this explains one: which
// required skills the résumé shows, which it doesn't, whether the years fit, and
// what to do about it. Rules only (no model), so it is free and instant.
// It never tells anyone to claim a skill: "add it if you have it" or "a real gap".
// ============================================================

export interface JobFit {
  /** 0–100, from IDF-weighted skill coverage, smooth years fit and résumé/posting wording similarity. */
  score: number;
  similarity: number;
  verdict: 'strong' | 'good' | 'stretch' | 'unlikely';
  headline: string;
  required: { have: string[]; missing: string[] };
  niceToHave: { have: string[]; missing: string[] };
  /** Skills the résumé's own text shows but its skills list leaves out: cheap wins for ATS keyword filters. */
  listThese: string[];
  experience: { yours: number | null; asks: string | null; status: 'meets' | 'below' | 'above' | 'unknown' };
  advice: string[];
}

const NICE = /\b(nice[\s-]to[\s-]have|preferred|bonus|good to have|plus|desirable|advantage|optional)\b/i;

/** Splits a posting at the first "nice to have"-style heading: what comes before is treated as required. */
function splitSections(description: string): { required: string; nice: string } {
  const m = NICE.exec(description);
  if (!m || m.index < 200) return { required: description, nice: '' };
  return { required: description.slice(0, m.index), nice: description.slice(m.index) };
}

export function analyzeFit(
  p: ProfileData,
  job: { title: string; description?: string | null; skills?: string[]; experience_min?: number | string | null; experience_max?: number | string | null; seniority?: string | null },
): JobFit {
  const { required: reqText, nice: niceText } = splitSections(job.description ?? '');
  const fromText = extractSkills(`${job.title}\n${reqText}`, 30);
  const reqSkills = [...new Set([...fromText, ...(niceText ? [] : (job.skills ?? []))])];
  const niceSkills = extractSkills(niceText, 20).filter((s) => !reqSkills.includes(s));

  const listed = new Set((p.skills ?? []).map((s) => s.toLowerCase()));
  const body = [
    ...(p.experience ?? []).flatMap((e) => [e.title, ...(e.highlights ?? [])]),
    ...(p.projects ?? []).flatMap((x) => [x.description ?? '', ...(x.tech ?? [])]),
    ...(p.certifications ?? []),
    p.personal?.summary ?? '',
    p.about ?? '',
  ].join('\n');
  const shown = new Set(extractSkills(body, 60).map((s) => s.toLowerCase()));
  const hasSkill = (s: string) => listed.has(s.toLowerCase()) || shown.has(s.toLowerCase());

  const required = { have: reqSkills.filter(hasSkill), missing: reqSkills.filter((s) => !hasSkill(s)) };
  const niceToHave = { have: niceSkills.filter(hasSkill), missing: niceSkills.filter((s) => !hasSkill(s)) };
  const listThese = [...reqSkills, ...niceSkills].filter((s) => !listed.has(s.toLowerCase()) && shown.has(s.toLowerCase()));

  const yours = yearsOfExperience(p);
  const min = job.experience_min != null ? Number(job.experience_min) : null;
  const max = job.experience_max != null ? Number(job.experience_max) : null;
  let status: JobFit['experience']['status'] = 'unknown';
  if (yours !== null && min !== null && Number.isFinite(min)) {
    status = yours + 0.5 < min ? 'below' : max !== null && Number.isFinite(max) && yours > max + 3 ? 'above' : 'meets';
  }
  const asks = min !== null && Number.isFinite(min) ? (max !== null && Number.isFinite(max) && max > min ? `${min}–${max} years` : `${min}+ years`) : null;

  // 55% skills (rare ones weigh more, few-skill jobs shrunk), 25% years (Gaussian), 20% wording similarity.
  const coverage = weightedCoverage(reqSkills, hasSkill);
  const yearsScore = yours !== null && (min !== null || max !== null) ? yearsFit(yours, min, max) : 0.6;
  const similarity = stretchSimilarity(cosine(body, `${job.title}\n${reqText}`));
  const points = (coverage * 0.55 + yearsScore * 0.25 + similarity * 0.2) * 100;
  const verdict: JobFit['verdict'] = points >= 72 ? 'strong' : points >= 55 ? 'good' : points >= 38 ? 'stretch' : 'unlikely';
  const headline = {
    strong: 'Strong fit: your résumé shows most of what this asks for',
    good: 'Good fit with a few gaps',
    stretch: 'A stretch: apply if the gaps are things you can learn quickly',
    unlikely: 'Unlikely to pass the first screen as the résumé stands',
  }[verdict];

  const advice: string[] = [];
  if (listThese.length) advice.push(`Add to your skills list (your résumé already shows them): ${listThese.slice(0, 6).join(', ')}.`);
  if (required.missing.length) advice.push(`Not on your résumé: ${required.missing.slice(0, 6).join(', ')}. Add any you have really used; if not, they are real gaps.`);
  if (status === 'below') advice.push(`Asks for ${asks}; you have about ${yours}. Lead with your strongest projects and results.`);
  if (status === 'above') advice.push(`Asks for ${asks}; you have more. Expect to be asked about pay and scope.`);
  if (!(p.experience ?? []).some((e) => (e.highlights ?? []).length >= 2)) advice.push('Add 3–5 achievement bullets to your latest role: screeners read those first.');

  return { score: Math.round(points), similarity: Math.round(similarity * 100) / 100, verdict, headline, required, niceToHave, listThese, experience: { yours, asks, status }, advice };
}
