import { createHash } from 'crypto';
import type { ProfileData } from './index.js';
import { yearsOfExperience } from './years.js';

// ============================================================
// RESUME ANALYSIS — what is strong, what is missing, and how much of a typical application the profile
// already answers. Pure rules, no AI: it runs on every profile change for free. Works from the structured
// profile, so it covers an uploaded résumé and the onboarding answers alike.
// Nothing here invents content: suggestions say what to add, never write it for the person.
// ============================================================

export interface Finding {
  id: string;
  severity: 'high' | 'medium' | 'low';
  area: 'contact' | 'summary' | 'experience' | 'skills' | 'education' | 'answers';
  title: string;
  fix: string;
}

export interface ResumeAnalysis {
  /** 0–100 */
  score: number;
  label: 'Needs work' | 'Good' | 'Strong';
  sections: { name: string; score: number; max: number }[];
  strengths: string[];
  findings: Finding[];
  keywords: { have: string[]; consider: string[] };
  coverage: { percent: number; answered: number; total: number; missing: { key: string; label: string }[] };
}

const has = (v: unknown) => (typeof v === 'string' ? v.trim().length > 0 : Array.isArray(v) ? v.length > 0 : v !== undefined && v !== null);
const QUANT = /\d|%|\$|₹|€|£|\b(x|k|m|million|lakh|crore)\b/i;
const ACTION = /^(built|led|designed|developed|created|implemented|improved|reduced|increased|launched|migrated|optimi[sz]ed|automated|managed|delivered|shipped|owned|wrote|architected|scaled|analy[sz]ed|trained|deployed|integrated|mentored|drove|cut|saved|grew|streamlined|refactored)\b/i;

/** Keywords recruiters' filters look for, by the kind of role the person is after. Suggestions only. */
const ROLE_KEYWORDS: { role: RegExp; words: string[] }[] = [
  { role: /back.?end|server|api|software|full.?stack|sde|developer|engineer/i, words: ['REST APIs', 'SQL', 'Git', 'Docker', 'CI/CD', 'System Design', 'Unit Testing', 'AWS'] },
  { role: /front.?end|ui|react|web/i, words: ['JavaScript', 'TypeScript', 'React', 'HTML', 'CSS', 'Responsive Design', 'Git', 'Testing'] },
  { role: /data (analyst|scientist|engineer)|analytics|machine learning|ml|ai/i, words: ['Python', 'SQL', 'Pandas', 'Statistics', 'Data Visualization', 'Machine Learning', 'ETL'] },
  { role: /devops|sre|cloud|platform|infra/i, words: ['Kubernetes', 'Docker', 'Terraform', 'CI/CD', 'Linux', 'AWS', 'Monitoring'] },
  { role: /qa|test|quality/i, words: ['Test Automation', 'Selenium', 'Playwright', 'API Testing', 'CI/CD', 'Jira'] },
  { role: /product|project|program/i, words: ['Roadmapping', 'Agile', 'Stakeholder Management', 'Jira', 'Analytics', 'User Research'] },
  { role: /design|ux/i, words: ['Figma', 'Prototyping', 'User Research', 'Design Systems', 'Usability Testing'] },
  { role: /market|seo|content|growth/i, words: ['SEO', 'Analytics', 'Content Strategy', 'Campaigns', 'A/B Testing'] },
];

/** What forms ask for most, and where the profile keeps it. Used for "how much would an application ask me?". */
const COMMON_QUESTIONS: { key: string; label: string; present: (p: ProfileData) => boolean }[] = [
  { key: 'name', label: 'Full name', present: (p) => has(p.personal?.fullName) },
  { key: 'email', label: 'Email', present: (p) => has(p.personal?.email) },
  { key: 'phone', label: 'Phone', present: (p) => has(p.personal?.phone) },
  { key: 'city', label: 'City', present: (p) => has(p.personal?.city) },
  { key: 'state', label: 'State / region', present: (p) => has(p.personal?.state) },
  { key: 'country', label: 'Country of residence', present: (p) => has(p.personal?.country) || has(p.personal?.detectedCountry) },
  { key: 'address', label: 'Street address', present: (p) => has(p.personal?.address) },
  { key: 'postal', label: 'PIN / ZIP code', present: (p) => has(p.personal?.postalCode) },
  { key: 'linkedin', label: 'LinkedIn', present: (p) => has(p.personal?.linkedin) },
  { key: 'portfolio', label: 'GitHub or website', present: (p) => has(p.personal?.github) || has(p.personal?.website) },
  { key: 'employer', label: 'Current employer', present: (p) => has(p.work?.currentEmployer) || !!p.experience?.length },
  { key: 'title', label: 'Current / latest job title', present: (p) => has(p.work?.currentTitle) || !!p.experience?.length },
  { key: 'years', label: 'Years of experience', present: (p) => yearsOfExperience(p) !== null },
  { key: 'notice', label: 'Notice period', present: (p) => has(p.work?.noticePeriod) },
  { key: 'expected', label: 'Expected salary', present: (p) => has(p.work?.expectedSalary) },
  { key: 'current', label: 'Current salary', present: (p) => has(p.work?.currentSalary) },
  { key: 'school', label: 'University', present: (p) => has(p.education?.[0]?.school) },
  { key: 'degree', label: 'Degree and field', present: (p) => has(p.education?.[0]?.degree) },
  { key: 'gradyear', label: 'Graduation year', present: (p) => has(p.education?.[0]?.end) },
  { key: 'skills', label: 'Skills', present: (p) => (p.skills?.length ?? 0) >= 3 },
  { key: 'auth', label: 'Work authorisation', present: (p) => has(p.authorization?.statement) || has(p.authorization?.countries) || p.authorization?.needsSponsorship !== undefined },
  { key: 'workplace', label: 'Remote / hybrid / on-site preference', present: (p) => has(p.preferences?.workplace) },
  { key: 'locations', label: 'Preferred locations', present: (p) => has(p.preferences?.locations) },
  { key: 'nationality', label: 'Nationality', present: (p) => has(p.personal?.nationality) },
  { key: 'about', label: 'About you (free text)', present: (p) => has(p.personal?.summary) || has(p.answerBank?.aboutYou) },
  { key: 'strengths', label: 'Strengths', present: (p) => has(p.answerBank?.strengths) },
  { key: 'achievement', label: 'Biggest achievement', present: (p) => has(p.answerBank?.achievement) },
  { key: 'goals', label: 'Career goals', present: (p) => has(p.answerBank?.careerGoal) },
];

const grade = (score: number): ResumeAnalysis['label'] => (score >= 80 ? 'Strong' : score >= 60 ? 'Good' : 'Needs work');

export function analyzeProfile(p: ProfileData): ResumeAnalysis {
  const findings: Finding[] = [];
  const strengths: string[] = [];
  const add = (f: Finding) => findings.push(f);

  // ── Contact (15)
  let contact = 0;
  const per = p.personal ?? {};
  for (const [ok, pts] of [[has(per.fullName), 3], [has(per.email), 3], [has(per.phone), 3], [has(per.city) || has(per.country), 3]] as const) contact += ok ? pts : 0;
  if (!has(per.fullName) || !has(per.email) || !has(per.phone)) {
    add({ id: 'contact-basics', severity: 'high', area: 'contact', title: 'Name, email or phone is missing', fix: 'Add all three — employers and application forms cannot proceed without them.' });
  }
  if (has(per.linkedin)) { contact += 3; strengths.push('LinkedIn is linked'); }
  else add({ id: 'linkedin', severity: 'medium', area: 'contact', title: 'No LinkedIn link', fix: 'Add your LinkedIn URL: many forms ask for it and recruiters check it.' });

  // ── Summary (10)
  let summary = 0;
  const sum = (per.summary ?? '').trim();
  if (sum.length >= 120 && sum.length <= 700) { summary = 10; strengths.push('A clear summary'); }
  else if (sum.length > 0) { summary = 5; add({ id: 'summary-length', severity: 'low', area: 'summary', title: sum.length < 120 ? 'Summary is very short' : 'Summary is long', fix: 'Aim for 2–4 sentences: your role, years of experience, strongest skills, what you want next.' }); }
  else add({ id: 'summary', severity: 'medium', area: 'summary', title: 'No summary', fix: 'Add a 2–4 sentence summary. We also use it to answer "tell us about yourself".' });

  // ── Experience (30)
  let experience = 0;
  const jobs = p.experience ?? [];
  const years = yearsOfExperience(p);
  if (!jobs.length) {
    if (years === 0 || p.work?.experienceLevel === 'Student / fresher') {
      experience = 12;
      add({ id: 'fresher-projects', severity: 'medium', area: 'experience', title: 'No experience listed', fix: 'As a fresher, list internships, projects and open-source work with what you built and the result.' });
    } else add({ id: 'experience', severity: 'high', area: 'experience', title: 'No work experience listed', fix: 'Add your roles with company, title, dates and 3–5 achievement bullets each.' });
  } else {
    experience += 10;
    const bullets = jobs.slice(0, 3).flatMap((j) => j.highlights ?? []);
    const dated = jobs.filter((j) => has(j.start)).length / jobs.length;
    experience += Math.round(dated * 4);
    if (dated < 1) add({ id: 'dates', severity: 'medium', area: 'experience', title: 'Some roles have no dates', fix: 'Give every role start and end months; gaps without dates look like hiding something.' });
    if (bullets.length < Math.min(jobs.length, 3) * 3) add({ id: 'bullets-few', severity: 'high', area: 'experience', title: 'Recent roles have few achievement bullets', fix: 'Write 3–5 bullets per recent role. Say what you did and what changed because of it.' });
    else { experience += 6; strengths.push('Recent roles are described in detail'); }
    if (bullets.length) {
      const quant = bullets.filter((b) => QUANT.test(b)).length / bullets.length;
      experience += Math.round(quant * 6);
      if (quant < 0.4) add({ id: 'quantify', severity: 'high', area: 'experience', title: 'Few bullets have numbers', fix: 'Add a measurable result where you honestly have one: "cut page load from 4s to 1.5s", "handled 20k requests/min", "mentored 3 interns".' });
      else strengths.push('Achievements are quantified');
      const actions = bullets.filter((b) => ACTION.test(b.trim())).length / bullets.length;
      experience += Math.round(actions * 4);
      if (actions < 0.5) add({ id: 'verbs', severity: 'low', area: 'experience', title: 'Bullets do not start with an action verb', fix: 'Start with what you did: Built, Led, Reduced, Migrated…' });
      const long = bullets.filter((b) => b.length > 260).length;
      if (long) add({ id: 'bullet-long', severity: 'low', area: 'experience', title: `${long} bullet${long === 1 ? ' is' : 's are'} too long`, fix: 'Keep each bullet to one or two lines (under 220 characters).' });
    }
  }

  // ── Skills (15)
  let skillsScore = 0;
  const skills = p.skills ?? [];
  if (skills.length >= 8) { skillsScore = 10; strengths.push(`${skills.length} skills listed`); }
  else if (skills.length >= 4) { skillsScore = 6; add({ id: 'skills-few', severity: 'medium', area: 'skills', title: 'Only a few skills listed', fix: 'List 8–15 skills you really use. Job matching and many forms are keyword-based.' }); }
  else add({ id: 'skills', severity: 'high', area: 'skills', title: 'Too few skills', fix: 'Add the tools and technologies you actually work with: they drive both your match score and form answers.' });
  const lowerSkills = new Set(skills.map((s) => s.toLowerCase()));
  const roleText = [...(p.preferences?.roles ?? []), p.work?.currentTitle ?? '', jobs[0]?.title ?? ''].join(' ');
  const consider = [...new Set(ROLE_KEYWORDS.filter((r) => r.role.test(roleText)).flatMap((r) => r.words))].filter((w) => !lowerSkills.has(w.toLowerCase())).slice(0, 8);
  if (consider.length >= 3) { skillsScore += 2; add({ id: 'keywords', severity: 'low', area: 'skills', title: 'Common keywords for your target roles are not on your résumé', fix: `If you genuinely have them, add: ${consider.slice(0, 5).join(', ')}.` }); }
  else skillsScore += 5;

  // ── Education (10)
  let education = 0;
  const edu = p.education?.[0];
  if (edu?.school) { education += 5; if (has(edu.degree)) education += 3; if (has(edu.end)) education += 2; if (!has(edu.degree) || !has(edu.end)) add({ id: 'edu-details', severity: 'low', area: 'education', title: 'Education is missing degree or graduation year', fix: 'Forms ask for both; add them once here.' }); }
  else add({ id: 'education', severity: 'medium', area: 'education', title: 'No education listed', fix: 'Add your highest qualification with the school and year.' });

  // ── Preferences / answers (10)
  const prefChecks = [has(p.preferences?.roles), has(p.preferences?.locations) || has(p.preferences?.workplace), has(p.work?.noticePeriod), has(p.work?.expectedSalary), has(p.authorization?.statement) || has(p.authorization?.countries) || p.authorization?.needsSponsorship !== undefined];
  const answers = Math.round((prefChecks.filter(Boolean).length / prefChecks.length) * 10);
  if (!has(p.preferences?.roles)) add({ id: 'roles', severity: 'high', area: 'answers', title: 'No target roles', fix: 'Pick the roles you want: they drive your match score and which jobs Auto Apply sends.' });
  if (!has(p.work?.noticePeriod)) add({ id: 'notice', severity: 'medium', area: 'answers', title: 'Notice period not set', fix: 'Forms ask it on almost every Indian application.' });
  if (!has(p.work?.expectedSalary)) add({ id: 'salary', severity: 'medium', area: 'answers', title: 'Expected salary not set', fix: 'Add a figure or range once, so applications are not stopped to ask.' });

  // ── Extras (10)
  let extras = 0;
  if (p.certifications?.length) { extras += 5; strengths.push('Certifications listed'); }
  if (p.projects?.length) { extras += 5; strengths.push('Projects listed'); }
  if (!extras && jobs.length < 2) add({ id: 'extras', severity: 'low', area: 'experience', title: 'No projects or certifications', fix: 'Two strong projects with links make up for a short work history.' });

  const sections = [
    { name: 'Contact', score: Math.min(contact, 15), max: 15 },
    { name: 'Summary', score: summary, max: 10 },
    { name: 'Experience', score: Math.min(experience, 30), max: 30 },
    { name: 'Skills', score: Math.min(skillsScore, 15), max: 15 },
    { name: 'Education', score: education, max: 10 },
    { name: 'Preferences', score: answers, max: 10 },
    { name: 'Extras', score: extras, max: 10 },
  ];
  const score = Math.round(sections.reduce((a, s) => a + s.score, 0));

  const missing = COMMON_QUESTIONS.filter((q) => !q.present(p));
  const total = COMMON_QUESTIONS.length;
  const sev = { high: 0, medium: 1, low: 2 } as const;
  return {
    score,
    label: grade(score),
    sections,
    strengths: strengths.slice(0, 5),
    findings: findings.sort((a, b) => sev[a.severity] - sev[b.severity]),
    keywords: { have: skills.slice(0, 15), consider },
    coverage: { percent: Math.round(((total - missing.length) / total) * 100), answered: total - missing.length, total, missing: missing.map((m) => ({ key: m.key, label: m.label })) },
  };
}

// ─── The answer bank: personal answers to the open questions every form asks ───

export interface AnswerBank {
  aboutYou?: string;
  strengths?: string;
  achievement?: string;
  careerGoal?: string;
  /** Hash of the facts these were written from: unchanged facts never trigger a rewrite. */
  hash?: string;
  /** Answers the person rewrote themselves: a refresh never overwrites these. */
  edited?: string[];
  /** 'resume' = assembled from the résumé by rule; 'ai' = polished once by the model. */
  source?: 'resume' | 'ai';
  updatedAt?: string;
}

const list = (a: string[]) => (a.length <= 1 ? a[0] ?? '' : `${a.slice(0, -1).join(', ')} and ${a[a.length - 1]}`);

/** The facts the answers are built from (and hashed), nothing else. */
export function bankFacts(p: ProfileData) {
  const jobs = p.experience ?? [];
  const best = jobs.slice(0, 3).flatMap((j) => (j.highlights ?? []).map((h) => ({ h, company: j.company }))).sort((a, b) => Number(QUANT.test(b.h)) - Number(QUANT.test(a.h)) || a.h.length - b.h.length)[0];
  return {
    title: p.work?.currentTitle || jobs[0]?.title || p.preferences?.roles?.[0] || '',
    company: p.work?.currentEmployer || jobs[0]?.company || '',
    years: yearsOfExperience(p),
    skills: (p.skills ?? []).slice(0, 6),
    roles: (p.preferences?.roles ?? []).slice(0, 3),
    degree: [p.education?.[0]?.degree, p.education?.[0]?.field].filter(Boolean).join(' in '),
    school: p.education?.[0]?.school ?? '',
    achievement: best?.h ?? '',
    achievementAt: best?.company ?? '',
    summary: (p.personal?.summary ?? '').trim(),
  };
}

export const bankHash = (p: ProfileData) => createHash('sha256').update(JSON.stringify(bankFacts(p))).digest('hex').slice(0, 16);

/** Assembled from the résumé by rule: first person, only what it says. Free, instant, always available. */
export function buildAnswerBank(p: ProfileData): AnswerBank {
  const f = bankFacts(p);
  const out: AnswerBank = { source: 'resume', hash: bankHash(p), updatedAt: new Date().toISOString() };
  const exp = f.years === null ? '' : f.years === 0 ? 'as a recent graduate' : `with ${f.years} year${f.years === 1 ? '' : 's'} of experience`;
  if (f.summary.length >= 80) out.aboutYou = f.summary.slice(0, 600);
  else if (f.title || f.skills.length) {
    const who = f.title ? `I'm ${/^[aeiou]/i.test(f.title) ? 'an' : 'a'} ${f.title}${f.company && p.work?.currentEmployer ? ` at ${f.company}` : ''}` : "I'm a professional";
    out.aboutYou = [`${who}${exp ? ` ${exp}` : ''}.`, f.skills.length ? `My work centres on ${list(f.skills.slice(0, 5))}.` : '', f.degree ? `I studied ${f.degree}${f.school ? ` at ${f.school}` : ''}.` : '', f.achievement ? `${/[.!?]$/.test(f.achievement) ? f.achievement : `${f.achievement}.`}` : ''].filter(Boolean).join(' ').slice(0, 600);
  }
  if (f.skills.length >= 2) out.strengths = `${list(f.skills.slice(0, 4))}${exp ? `, backed by ${exp.replace(/^with /, '')}` : ''}${f.achievement ? `. For example: ${f.achievement.replace(/[.]$/, '')}` : ''}.`.replace(/^(.)/, (c) => c.toUpperCase()).slice(0, 500);
  if (f.achievement) out.achievement = `${f.achievement.replace(/[.]$/, '')}${f.achievementAt ? ` (at ${f.achievementAt})` : ''}.`.slice(0, 500);
  if (f.roles.length) out.careerGoal = `I'm looking to grow as ${/^[aeiou]/i.test(f.roles[0]) ? 'an' : 'a'} ${f.roles[0]}${f.roles.length > 1 ? `, and I'm also open to ${list(f.roles.slice(1))} roles` : ''}${f.skills.length ? `, building on my work with ${list(f.skills.slice(0, 3))}` : ''}.`;
  return out;
}

/** Answers onboarding cannot be finished without: every application asks these, so they are never skipped. */
export function missingRequired(p: ProfileData): { key: string; label: string }[] {
  const need: { key: string; label: string; ok: boolean }[] = [
    { key: 'fullName', label: 'your name', ok: has(p.personal?.fullName) },
    { key: 'phone', label: 'a phone number', ok: (p.personal?.phone ?? '').replace(/\D/g, '').length >= 10 },
    { key: 'location', label: 'where you live', ok: has(p.personal?.city) || has(p.personal?.country) },
    { key: 'experience', label: 'your experience level', ok: has(p.work?.experienceLevel) || p.work?.yearsOfExperience !== undefined || !!p.experience?.length },
    { key: 'authorization', label: 'your work authorisation', ok: has(p.authorization?.statement) || has(p.authorization?.countries) || p.authorization?.needsSponsorship !== undefined },
    { key: 'roles', label: 'the roles you want', ok: has(p.preferences?.roles) },
    { key: 'workplace', label: 'remote / hybrid / on-site or locations', ok: has(p.preferences?.workplace) || has(p.preferences?.locations) },
    { key: 'notice', label: 'your notice period', ok: has(p.work?.noticePeriod) },
    { key: 'salary', label: 'your expected salary', ok: has(p.work?.expectedSalary) },
  ];
  return need.filter((n) => !n.ok).map(({ key, label }) => ({ key, label }));
}
