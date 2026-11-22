import type { BrowserContext } from 'playwright';
import { mkdir, writeFile } from 'fs/promises';
import { join } from 'path';
import type { ProfileData } from '../shared/profile/index.js';
import { complete } from '../shared/llm/gateway.js';
import { isDummyLLMKey } from '../shared/llm/index.js';
import { createLogger } from '../shared/logger/index.js';

// ============================================================
// COVER LETTER — for forms that require one (Zoho often does). Written only
// from what the profile says (no invented achievements): by the AI model
// when one is configured, else a plain template. Uploads get a PDF printed
// by the run's own browser.
// ============================================================

const logger = createLogger('cover-letter');

export interface CoverLetterJob {
  title?: string;
  company?: string;
  /** Comma-separated skills the posting asks for: the letter leads with the ones the person really has. */
  skills?: string;
}

const nameOf = (p: ProfileData) =>
  p.personal?.fullName?.trim() || [p.personal?.firstName, p.personal?.lastName].filter(Boolean).join(' ') || '';

/** The facts a letter may use — nothing else. */
export function coverLetterFacts(p: ProfileData): string[] {
  const out: string[] = [];
  const w = p.work ?? {};
  if (w.currentTitle) out.push(`Current role: ${w.currentTitle}${w.currentEmployer ? ` at ${w.currentEmployer}` : ''}`);
  if (w.yearsOfExperience != null) out.push(`Years of experience: ${w.yearsOfExperience}`);
  if (p.skills?.length) out.push(`Skills: ${p.skills.slice(0, 12).join(', ')}`);
  const edu = p.education?.[0];
  if (edu?.school) out.push(`Education: ${[edu.degree, edu.field].filter(Boolean).join(' in ')}${edu.degree || edu.field ? ', ' : ''}${edu.school}`);
  for (const e of (p.experience ?? []).slice(0, 2)) {
    if (e.highlights?.length) out.push(`At ${e.company} (${e.title}): ${e.highlights.slice(0, 2).join('; ')}`);
  }
  if (p.personal?.summary) out.push(`Summary: ${p.personal.summary.slice(0, 400)}`);
  if (w.noticePeriod) out.push(`Notice period: ${w.noticePeriod}`);
  if (edu?.end) out.push(`Education ${edu.current ? 'expected end' : 'ended'}: ${edu.end}`);
  if (edu?.grade) out.push(`Grade / CGPA: ${edu.grade}`);
  const loc = [p.personal?.city, p.personal?.state, p.personal?.country].filter(Boolean).join(', ');
  if (loc) out.push(`Lives in: ${loc}`);
  if (p.personal?.nationality) out.push(`Nationality: ${p.personal.nationality}`);
  if (p.certifications?.length) out.push(`Certifications: ${p.certifications.slice(0, 8).join('; ')}`);
  if (p.authorization?.statement) out.push(`Work authorization: ${p.authorization.statement}`);
  if (p.about?.trim()) out.push(`In their own words: ${p.about.trim().slice(0, 4000)}`);
  return out;
}

const matchedOf = (p: ProfileData, skills?: string) => {
  const mine = new Set((p.skills ?? []).map((x) => x.toLowerCase()));
  return (skills ?? '').split(',').map((x) => x.trim()).filter((x) => x && mine.has(x.toLowerCase())).slice(0, 8);
};

export function templateLetter(p: ProfileData, job: CoverLetterJob): string {
  const name = nameOf(p) || 'Applicant';
  const w = p.work ?? {};
  const role = job.title || 'this role';
  const at = job.company ? ` at ${job.company}` : '';
  const lines = [`Dear Hiring Team${job.company ? ` at ${job.company}` : ''},`, ''];
  const intro = [`I am writing to apply for ${role}${at}.`];
  if (w.currentTitle) intro.push(`I currently work as ${w.currentTitle}${w.currentEmployer ? ` at ${w.currentEmployer}` : ''}${w.yearsOfExperience != null ? `, with ${w.yearsOfExperience} years of experience` : ''}.`);
  else if (w.yearsOfExperience != null) intro.push(`I bring ${w.yearsOfExperience} years of experience.`);
  lines.push(intro.join(' '));
  if (p.skills?.length) lines.push('', `My work centres on ${p.skills.slice(0, 6).join(', ')}, and I would welcome the chance to apply it here.`);
  const highlight = p.experience?.find((e) => e.highlights?.length);
  if (highlight) lines.push('', `Recently, at ${highlight.company}, ${highlight.highlights![0].replace(/^[A-Z]/, (c) => c.toLowerCase()).replace(/\.$/, '')}.`);
  lines.push('', `My résumé is attached${w.noticePeriod ? `, and my notice period is ${w.noticePeriod}` : ''}. Thank you for considering my application.`, '', 'Sincerely,', name);
  return lines.join('\n');
}

/** The letter's text: the model writes it from the profile's facts, else the template. */
export async function coverLetterText(p: ProfileData, job: CoverLetterJob, ids: { userId: string; jobId: string }): Promise<string> {
  const known = coverLetterFacts(p);
  if (!isDummyLLMKey() && known.length) {
    try {
      const { text } = await complete({
        purpose: 'field_answers',
        userId: ids.userId,
        jobId: ids.jobId,
        maxTokens: 500,
        temperature: 0.4,
        timeoutMs: 30_000,
        messages: [
          {
            role: 'system',
            content:
              'Write a short, plain cover letter (120–180 words) in the first person. Use ONLY the facts given — never invent employers, numbers, achievements or skills. Open with why this role fits (name the matching skills or experience from the facts), give one concrete example from the facts, close with availability; no flattery or filler. No placeholders, no brackets, no subject line. Start with "Dear Hiring Team" and end with "Sincerely," and the name.',
          },
          {
            role: 'user',
            content: `Role: ${job.title || 'the role'}\nCompany: ${job.company || 'the company'}\nName: ${nameOf(p)}\nFacts:\n- ${[...(matchedOf(p, job.skills).length ? [`Skills the candidate has that this role asks for: ${matchedOf(p, job.skills).join(', ')}`] : []), ...known].join('\n- ')}`,
          },
        ],
      });
      const letter = text.trim();
      // A reply with placeholders or far off length is not sent to an employer.
      if (letter.length > 300 && letter.length < 2500 && !/\[[^\]]+\]|\{\{|lorem/i.test(letter)) return letter;
    } catch (err) {
      logger.warn('cover-letter:llm-failed', { error: (err as Error).message });
    }
  }
  return templateLetter(p, job);
}

const escapeHtml = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

/** A PDF of the letter, printed by the run's browser; a .txt when this browser can't print. */
export async function coverLetterFile(context: BrowserContext, dir: string, text: string, name: string): Promise<string> {
  await mkdir(dir, { recursive: true });
  const base = `${(name || 'Cover').replace(/[^\p{L}\p{N}]+/gu, '_').replace(/^_|_$/g, '')}_Cover_Letter`;
  const page = await context.newPage();
  try {
    await page.setContent(
      `<!doctype html><html><head><meta charset="utf-8"><style>body{font:12pt/1.55 Georgia,serif;margin:28mm 24mm;color:#111}p{margin:0 0 10pt}</style></head><body>${text
        .split(/\n{2,}/)
        .map((para) => `<p>${escapeHtml(para).replace(/\n/g, '<br>')}</p>`)
        .join('')}</body></html>`,
    );
    const pdf = join(dir, `${base}.pdf`);
    await page.pdf({ path: pdf, format: 'A4' });
    return pdf;
  } catch {
    const txt = join(dir, `${base}.txt`);
    await writeFile(txt, text, 'utf8');
    return txt;
  } finally {
    await page.close().catch(() => {});
  }
}
