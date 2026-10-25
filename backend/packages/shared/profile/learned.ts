import { profileService } from './index.js';

// Answers the person gave to a form question are copied into their "Tell us more about you" notes, so the AI
// can answer the same kind of question — worded differently, on another site — without asking again.

const SKIP = /password|passcode|\botp\b|\bcode\b|aadhaar|aadhar|\bpan\b|passport|\bssn\b|signature|consent|privacy|acknowledg|agree|terms|declar|certify|captcha|\bcvv\b|card/i;
const MARK = '↳ ';

export async function learnAnswer(userId: string, question: string, answer: string): Promise<void> {
  const q = question.replace(/\s+/g, ' ').trim();
  const a = answer.replace(/\s+/g, ' ').trim();
  if (!q || !a || q.length > 160 || a.length > 140 || SKIP.test(q)) return;
  const profile = await profileService.get(userId).catch(() => null);
  if (!profile) return;
  const lines = (profile.data.about ?? '').split('\n').filter((l) => l.trim());
  const key = q.toLowerCase();
  const next = lines.filter((l) => !(l.startsWith(MARK) && l.toLowerCase().includes(key)));
  next.push(`${MARK}${q}: ${a}`);
  // Keep the most recent learned lines when the notes get long.
  while (next.join('\n').length > 3900) {
    const i = next.findIndex((l) => l.startsWith(MARK));
    if (i < 0) break;
    next.splice(i, 1);
  }
  await profileService.patch(userId, { about: next.join('\n') }, 'learned-answer');
}
