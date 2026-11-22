import { completeJSON, LLMBlockedError } from '../llm/gateway.js';
import { getBool } from '../config/settings.js';
import { getPgPool } from '../db/index.js';
import { getObject } from '../storage/index.js';
import { createLogger } from '../logger/index.js';
import type { ProfileData } from './index.js';
import { extractCertifications, extractEducation, extractExperience, extractSkillList, extractSummary } from './resume-sections.js';

// ============================================================
// RESUME → PROFILE
// 1. text extraction (unpdf for PDF, mammoth for DOCX)
// 2. zero-token rules (email, phone, links, known skills) — always applied
// 3. one cheap model call with a strict schema for the structured parts
// The result is stored on resume_parses for the user to review/apply; it is
// never written into the profile without the user confirming.
// ============================================================

const logger = createLogger('resume-parser');
const MAX_CHARS = 14_000;

export async function extractResumeText(buffer: Buffer, fileName: string, mimeType: string): Promise<string> {
  const name = fileName.toLowerCase();
  if (mimeType === 'application/pdf' || name.endsWith('.pdf')) {
    // Keep the PDF's line breaks: the rules below read the header line by line
    // (name on the first line, contact details next) and a merged single line breaks them.
    const { getDocumentProxy } = await import('unpdf');
    const pdf = await getDocumentProxy(new Uint8Array(buffer));
    const pages: string[] = [];
    for (let i = 1; i <= pdf.numPages; i++) {
      const content = await (await pdf.getPage(i)).getTextContent();
      let line = '';
      const lines: string[] = [];
      for (const item of content.items as { str?: string; hasEOL?: boolean }[]) {
        line += item.str ?? '';
        if (item.hasEOL) {
          lines.push(line.trim());
          line = '';
        }
      }
      if (line.trim()) lines.push(line.trim());
      pages.push(lines.filter(Boolean).join('\n'));
    }
    return pages.join('\n\n');
  }
  if (name.endsWith('.docx') || mimeType.includes('wordprocessingml')) {
    const mammoth = await import('mammoth');
    const { value } = await mammoth.extractRawText({ buffer });
    return value;
  }
  if (mimeType.startsWith('text/') || name.endsWith('.txt') || name.endsWith('.md')) {
    return buffer.toString('utf8');
  }
  throw new Error('Unsupported resume format — upload a PDF, DOCX or TXT file');
}

const SKILL_WORDS = [
  'JavaScript', 'TypeScript', 'Python', 'Java', 'Kotlin', 'Swift', 'Go', 'Rust', 'C++', 'C#', 'PHP', 'Ruby', 'Dart', 'Scala', 'R',
  'React', 'Next.js', 'Angular', 'Vue', 'Svelte', 'Node.js', 'Express', 'NestJS', 'Django', 'Flask', 'FastAPI', 'Spring Boot',
  'Flutter', 'React Native', 'Android', 'iOS', 'HTML', 'CSS', 'Tailwind', 'Redux', 'GraphQL', 'REST', 'gRPC',
  'SQL', 'PostgreSQL', 'MySQL', 'MongoDB', 'Redis', 'Firebase', 'Supabase', 'Elasticsearch', 'Kafka', 'RabbitMQ',
  'AWS', 'GCP', 'Azure', 'Docker', 'Kubernetes', 'Terraform', 'Linux', 'Git', 'CI/CD', 'Jenkins', 'GitHub Actions',
  'Machine Learning', 'Deep Learning', 'TensorFlow', 'PyTorch', 'Pandas', 'NumPy', 'scikit-learn', 'LLM', 'NLP',
  'Excel', 'Power BI', 'Tableau', 'Figma', 'Jira', 'Agile', 'Scrum', 'Playwright', 'Selenium', 'Jest',
];

const INDIAN_STATES = ['Andhra Pradesh', 'Arunachal Pradesh', 'Assam', 'Bihar', 'Chhattisgarh', 'Goa', 'Gujarat', 'Haryana', 'Himachal Pradesh', 'Jharkhand', 'Karnataka', 'Kerala', 'Madhya Pradesh', 'Maharashtra', 'Manipur', 'Meghalaya', 'Mizoram', 'Nagaland', 'Odisha', 'Punjab', 'Rajasthan', 'Sikkim', 'Tamil Nadu', 'Telangana', 'Tripura', 'Uttar Pradesh', 'Uttarakhand', 'West Bengal', 'Delhi', 'Jammu & Kashmir', 'Chandigarh', 'Puducherry'];

/** Deterministic extraction — free, always runs. */
export function ruleExtract(text: string): ProfileData {
  // A link that wrapped at a hyphen ("github.com/jane-" ⏎ "doe") is one link.
  text = text.replace(/((?:github\.com|linkedin\.com\/in)\/[A-Za-z0-9_-]*-)\s*\n\s*([A-Za-z0-9_-])/gi, '$1$2');
  const email = text.match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/)?.[0];
  // Any phone-like span with 10–13 digits (+91 98765 43210, (415) 555-0100, 9876543210 …).
  const phone = (text.match(/\+?\(?\d[\d\s().-]{8,18}\d/g) ?? [])
    .map((m) => m.trim())
    .find((m) => {
      const digits = m.replace(/\D/g, '').length;
      return digits >= 10 && digits <= 13 && !/^\d{4}\s*-\s*\d{4}$/.test(m);
    });
  const linkedin = text.match(/(https?:\/\/)?(www\.)?linkedin\.com\/in\/[A-Za-z0-9_-]+\/?/i)?.[0];
  const github = text.match(/(https?:\/\/)?(www\.)?github\.com\/[A-Za-z0-9_-]+\/?/i)?.[0];
  const lower = ` ${text.toLowerCase()} `;
  const skills = SKILL_WORDS.filter((s) => {
    const esc = s.toLowerCase().replace(/[.+#/]/g, (c) => `\\${c}`);
    return new RegExp(`[^a-z0-9]${esc}[^a-z0-9]`).test(lower);
  });
  const withScheme = (u?: string) => (u && !u.startsWith('http') ? `https://${u}` : u);
  // The name is almost always the first line: 2–4 capitalised words, no digits/@/links.
  const firstLine = text.split('\n').map((l) => l.trim()).find(Boolean) ?? '';
  const fullName = /^[A-Z][A-Za-z.'-]+(?:\s+[A-Z][A-Za-z.'-]+){1,3}$/.test(firstLine) && !/resume|curriculum|vitae/i.test(firstLine)
    ? firstLine
    : undefined;
  const [firstName, ...rest] = fullName?.split(/\s+/) ?? [];
  // "Bengaluru, India" / "Pune, Maharashtra" style location in the contact header.
  const header = text.split('\n').slice(0, 6).join(' | ');
  // Also "San Francisco, CA, USA" (city, state, country).
  const place = header.match(/(?:^|[|·•,]\s*)([A-Z][a-z]+(?:\s[A-Z][a-z]+)?),\s*(?:([A-Z]{2}|[A-Z][a-z]+(?:\s[A-Z][a-z]+)?),\s*)?(India|United States|USA|US|[A-Z][a-z]+)(?=\s*(?:$|[|·•]))/);
  const inState = place ? null : header.match(new RegExp(`(?:^|[|·•]\\s*)([A-Z][a-z]+(?:\\s[A-Z][a-z]+)?),\\s*(${INDIAN_STATES.join('|')})\\b`));
  const country = inState ? 'IN' : place?.[3] === 'India' ? 'IN' : /^(United States|USA|US)$/.test(place?.[3] ?? '') ? 'US' : undefined;
  // "3 years of experience" → the experience bands the onboarding form uses.
  const years = Number(text.match(/(\d{1,2})\+?\s+years?\s+of\s+(?:professional\s+|industry\s+|work\s+)?experience/i)?.[1] ?? NaN);
  const experience = extractExperience(text);
  const summary = extractSummary(text);
  const certifications = extractCertifications(text);
  const listed = extractSkillList(text);
  const education = extractEducation(text);
  const currentJob = experience.find((e) => e.current);
  const experienceLevel = Number.isNaN(years) ? undefined
    : years < 1 ? 'Student / fresher' : years < 2 ? '0–2 years' : years < 5 ? '2–5 years' : years < 10 ? '5–10 years' : '10+ years';
  return {
    personal: {
      fullName, firstName: fullName ? firstName : undefined, lastName: fullName ? rest.join(' ') : undefined,
      email, phone, linkedin: withScheme(linkedin), github: withScheme(github),
      city: place?.[1] ?? inState?.[1], state: place?.[2] ?? inState?.[2], country, summary,
    },
    work: experienceLevel || currentJob
      ? { experienceLevel, currentEmployer: currentJob?.company || undefined, currentTitle: currentJob?.title || undefined }
      : undefined,
    experience: experience.length ? experience : undefined,
    education: education.length ? education : undefined,
    skills: [...new Set([...skills, ...listed])].length ? [...new Set([...skills, ...listed])].slice(0, 40) : undefined,
    certifications: certifications.length ? certifications : undefined,
  };
}

const SCHEMA_HINT = `Return ONLY a JSON object with this shape (omit unknown fields, never invent):
{
  "personal": { "fullName": "", "firstName": "", "lastName": "", "email": "", "phone": "", "city": "", "state": "", "country": "", "linkedin": "", "github": "", "website": "", "summary": "" },
  "work": { "currentEmployer": "", "currentTitle": "", "yearsOfExperience": 0, "experienceLevel": "Student / fresher | 0–2 years | 2–5 years | 5–10 years | 10+ years" },
  "education": [{ "school": "", "degree": "", "field": "", "start": "YYYY-MM", "end": "YYYY-MM", "current": false, "grade": "" }],
  "experience": [{ "company": "", "title": "", "location": "", "start": "YYYY-MM", "end": "YYYY-MM", "current": false, "highlights": ["…"] }],
  "skills": ["…"],
  "certifications": ["…"],
  "projects": [{ "name": "", "description": "", "url": "", "tech": ["…"] }]
}`;

export async function parseResumeText(text: string, userId?: string): Promise<{ data: ProfileData; model: string | null }> {
  const rules = ruleExtract(text);
  const clipped = text.replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').slice(0, MAX_CHARS);
  try {
    const { data, model } = await completeJSON<ProfileData>({
      purpose: 'resume_parse',
      maxTokens: 2500,
      userId,
      messages: [
        {
          role: 'system',
          content: `You convert resume text into structured JSON for a job-application profile. Copy facts exactly as written; never guess or embellish. ${SCHEMA_HINT}`,
        },
        { role: 'user', content: clipped },
      ],
    });
    // Rules win for fields they can read reliably (contact + links); model fills the rest.
    const merged: ProfileData = {
      ...data,
      personal: { ...(data.personal ?? {}), ...stripEmpty(rules.personal ?? {}) },
      work: { ...(rules.work ?? {}), ...(data.work ?? {}) },
      experience: data.experience?.length ? data.experience : rules.experience,
      education: data.education?.length ? data.education : rules.education,
      skills: dedupe([...(data.skills ?? []), ...(rules.skills ?? [])]),
    };
    return { data: merged, model };
  } catch (err) {
    if (!(err instanceof LLMBlockedError)) logger.warn('resume:llm-failed', { error: (err as Error).message });
    return { data: rules, model: null };
  }
}

const stripEmpty = (o: Record<string, unknown>) =>
  Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined && v !== ''));
const dedupe = (a: string[]) => [...new Map(a.filter(Boolean).map((s) => [s.toLowerCase(), s.trim()])).values()];

/** Run a queued parse (worker side). */
export async function runResumeParse(parseId: string): Promise<void> {
  const pool = getPgPool();
  const { rows } = await pool.query(
    `SELECT p.id, p.user_id, f.storage_path, f.original_name, f.mime_type
       FROM resume_parses p JOIN user_files f ON f.id = p.file_id
      WHERE p.id = $1`,
    [parseId],
  );
  const job = rows[0];
  if (!job) throw new Error(`Resume parse ${parseId} not found`);
  await pool.query(`UPDATE resume_parses SET status = 'running' WHERE id = $1`, [parseId]);
  try {
    if (!(await getBool('features.resume_parse'))) throw new Error('Resume parsing is turned off');
    const text = await extractResumeText(await getObject(job.storage_path), job.original_name, job.mime_type);
    if (text.trim().length < 80) throw new Error("Couldn't read text from this file (it may be a scanned image)");
    const { data, model } = await parseResumeText(text, job.user_id);
    await pool.query(
      `UPDATE resume_parses SET status = 'done', text_chars = $2, result = $3, model = $4, completed_at = NOW() WHERE id = $1`,
      [parseId, text.length, JSON.stringify(data), model],
    );
  } catch (err) {
    await pool.query(
      `UPDATE resume_parses SET status = 'failed', error = $2, completed_at = NOW() WHERE id = $1`,
      [parseId, (err as Error).message.slice(0, 500)],
    );
    throw err;
  }
}
