import { loadAnswerDefaults } from '../shared/answers/defaults.js';
import type { ProfileData } from '../shared/profile/index.js';
import { buildAnswerBook, planAnswers, type FormField } from './form-filler.js';
import { classifyIntent, isSensitive } from '../shared/profile/intent.js';
import type { SchemaField } from '../shared/applications/form-schema.js';

// ============================================================
// FORM PREVIEW — answer a posting's remembered questions from the user's profile and
// saved answers, without a browser. Same planner the live run uses, so the promise
// matches what will happen.
// ============================================================

export interface FormPreview {
  total: number;
  required: number;
  /** Answered from the profile or saved answers. */
  ready: number;
  /** Required questions only the person can answer. */
  needYou: Array<{ question: string; kind: string; sensitive: boolean }>;
  pages: number;
  complete: boolean;
}

export async function previewForm(
  schema: { fields: SchemaField[]; pages: number; complete: boolean },
  profile: ProfileData,
  recall: (q: string) => Promise<string | null>,
  job: { country?: string | null } = {},
): Promise<FormPreview> {
  const fields: FormField[] = schema.fields.map((f, idx) => ({ idx, tag: f.tag, type: f.type, label: f.label, name: f.name, required: f.required, options: f.options, value: '' }));
  const { answers, missing } = await planAnswers(fields, buildAnswerBook(profile, job), recall, undefined, await loadAnswerDefaults());
  return {
    total: fields.filter((f) => f.type !== 'captcha').length,
    required: fields.filter((f) => f.required).length,
    ready: answers.length,
    needYou: missing
      .filter((f) => f.required && f.type !== 'file')
      .map((f) => ({ question: f.label, kind: f.type, sensitive: isSensitive(classifyIntent(f.label, { tag: f.tag })) })),
    pages: schema.pages,
    complete: schema.complete,
  };
}
