import type { CandidateProfile, QuestionDefinition, QuestionOption } from './types.js';

export interface ResolutionOutput {
  answers: Record<string, string | number>;
  unresolvedRequired: QuestionDefinition[];
  requiresUserAction: boolean;
  warnings: string[];
}

/**
 * Universal Question and Field Resolver for Direct ATS API Submissions.
 * Intelligently maps candidate profile data, work history, answers bank,
 * and standard legal/EEO declarations into ATS form answers.
 *
 * CRITICAL SAFETY RULE: Never blindly guess or default unknown mandatory questions
 * regarding non-competes, legal agreements, criminal history, or custom questionnaires.
 * Unresolved mandatory questions trigger `requiresUserAction = true`.
 */
export class QuestionResolver {
  /**
   * Resolves answers with strict validation of mandatory questions.
   */
  static resolveAllDetailed(
    questions: QuestionDefinition[],
    candidate: CandidateProfile,
    jobCountry?: string | null,
  ): ResolutionOutput {
    const answers: Record<string, string | number> = {};
    const unresolvedRequired: QuestionDefinition[] = [];
    const warnings: string[] = [];

    for (const q of questions) {
      // If the question is for Resume/CV and candidate has binary resume attached:
      const hasResumeField = q.fields.some((f) => f.type === 'input_file' || f.name === 'resume' || f.name === 'cv');
      const isResumeQuestion = hasResumeField || /resume|curriculum vitae|\bcv\b/i.test(q.label);
      if (isResumeQuestion) {
        if (candidate.resume && candidate.resume.buffer && candidate.resume.buffer.byteLength > 0) {
          // Question is satisfied by multipart binary attachment
          continue;
        } else if (q.required) {
          unresolvedRequired.push(q);
          warnings.push('Mandatory resume/CV binary upload missing');
          continue;
        }
      }

      // If the question is for Cover Letter:
      const isCoverLetter = /cover letter/i.test(q.label);
      if (isCoverLetter) {
        if (candidate.coverLetter?.text) {
          const textField = q.fields.find((f) => f.type === 'textarea' || f.type === 'input_text');
          if (textField) answers[textField.name] = candidate.coverLetter.text;
        }
        continue;
      }

      // A required question with no field metadata cannot be safely answered.
      // Treat an incomplete schema as applicant action instead of silently
      // submitting an empty value.
      if (q.required && q.fields.length === 0) {
        unresolvedRequired.push(q);
        warnings.push(`Mandatory question "${q.label}" has no field metadata`);
        continue;
      }

      for (const field of q.fields) {
        if (field.type === 'input_file') continue;

        const resolved = this.resolveField(q, field.name, field.type, field.values, candidate, jobCountry);
        if (resolved !== undefined && resolved !== null && resolved !== '') {
          answers[field.name] = resolved;
        } else if (q.required) {
          // Check if it's voluntary EEO disclosure where candidate has chosen to decline
          const isEeo = /gender|sex|race|ethnicity|veteran|disability/i.test(q.label);
          if (!q.required && isEeo && field.values && field.values.length > 0) {
            const decline = field.values.find((o) => /decline|prefer not|wish not|not to disclose/i.test(o.label));
            if (decline) {
              answers[field.name] = decline.value;
              continue;
            }
          }

          // Non-compete, criminal record, background checks, or custom technical questions:
          // NEVER guess or default! Require explicit applicant action.
          unresolvedRequired.push(q);
          warnings.push(`Mandatory question "${q.label}" cannot be resolved from profile and requires applicant input`);
        }
      }
    }

    return {
      answers,
      unresolvedRequired,
      requiresUserAction: unresolvedRequired.length > 0,
      warnings,
    };
  }

  /**
   * Resolves answers for all questions in a given schema (backward-compatible).
   */
  static resolveAll(
    questions: QuestionDefinition[],
    candidate: CandidateProfile,
    jobCountry?: string | null,
  ): Record<string, string | number> {
    return this.resolveAllDetailed(questions, candidate, jobCountry).answers;
  }

  /**
   * Resolves a single field value.
   */
  static resolveField(
    question: QuestionDefinition,
    fieldName: string,
    fieldType: string,
    options: QuestionOption[] | undefined,
    candidate: CandidateProfile,
    jobCountry?: string | null,
  ): string | number | undefined {
    const label = (question.label || fieldName).toLowerCase();

    // These answers are personal/legal attestations. They must never be
    // guessed from defaults, a generic profile, or another question's answer.
    // Explicit decline-to-disclose remains available for voluntary EEO fields.
    const eeo = this.matches(label, ['gender', 'sex', 'race', 'ethnicity', 'veteran', 'disability', 'handicapped']);
    if (eeo) {
      const decline = options?.find((o) => /decline|prefer not|wish not|not to disclose|do not want to answer|not specified/i.test(o.label));
      if (decline && question.required === false) return decline.value;
      return undefined;
    }
    if (this.matches(label, ['authorized to work', 'legal authorization', 'legally authorized', 'work authorization', 'eligible to work'])) {
      const country = (jobCountry || candidate.personal.country || '').toLowerCase();
      const authorizedCountries = candidate.authorization?.authorizedCountries?.map((c) => c.toLowerCase()) ?? [];
      if (!country || !authorizedCountries.includes(country)) return undefined;
      return this.matchOption(options, 'Yes', ['yes', 'authorized', 'true']);
    }
    if (this.matches(label, ['require sponsorship', 'require visa', 'need sponsorship', 'sponsorship for employment', 'future require sponsorship'])) {
      const needs = candidate.authorization?.needsSponsorship;
      if (needs === undefined) return undefined;
      return this.matchOption(options, needs ? 'Yes' : 'No', needs ? ['yes'] : ['no', 'will not require']);
    }
    if (/criminal|conviction|non.?compete|background check|drug test|consent|certif|attest|declar|signature|legally bound/i.test(label)) {
      return undefined;
    }

    // 1. Core Profile Identity
    if (this.matches(label, ['first name', 'given name', 'fname'])) {
      return candidate.personal.firstName;
    }
    if (this.matches(label, ['last name', 'surname', 'family name', 'lname'])) {
      return candidate.personal.lastName;
    }
    if (this.matches(label, ['full name', 'candidate name', 'applicant name']) && !this.matches(label, ['preferred', 'former'])) {
      return candidate.personal.fullName;
    }
    if (this.matches(label, ['preferred name', 'nickname'])) {
      return candidate.personal.firstName;
    }
    if (this.matches(label, ['email', 'email address'])) {
      return candidate.personal.email;
    }
    if (this.matches(label, ['phone', 'mobile', 'telephone', 'cell', 'contact number'])) {
      return candidate.personal.phone;
    }

    // 2. Work Authorization & Visas (Evaluate before generic location/state)
    if (this.matches(label, ['authorized to work', 'legal authorization', 'legally authorized', 'work authorization', 'eligible to work'])) {
      const country = (jobCountry || candidate.personal.country || '').toLowerCase();
      const authorizedCountries = candidate.authorization?.authorizedCountries?.map((c) => c.toLowerCase()) ?? [];
      if (!country || !authorizedCountries.includes(country)) return undefined;
      return this.matchOption(options, 'Yes', ['yes', 'authorized', 'true']);
    }
    if (this.matches(label, ['require sponsorship', 'require visa', 'need sponsorship', 'sponsorship for employment', 'future require sponsorship'])) {
      const needs = candidate.authorization?.needsSponsorship;
      if (needs === undefined) return undefined;
      return this.matchOption(options, needs ? 'Yes' : 'No', needs ? ['yes'] : ['no', 'will not require']);
    }

    // 4. Location & Address
    if (this.matches(label, ['address line 1', 'street address', 'address'])) {
      return candidate.personal.address || undefined;
    }
    if (this.matches(label, ['city', 'municipality'])) {
      return candidate.personal.city || '';
    }
    if (this.matches(label, ['state', 'province', 'region']) && !label.includes('united states') && !label.includes('please state')) {
      return candidate.personal.state || '';
    }
    if (this.matches(label, ['postal code', 'zip code', 'zipcode', 'pincode'])) {
      return candidate.personal.postalCode || '';
    }
    if (this.matches(label, ['country of residence', 'current country', 'country'])) {
      const country = candidate.personal.country;
      if (!country) return undefined;
      return this.matchOption(options, country) ?? country;
    }

    // 5. URLs & Social
    if (this.matches(label, ['linkedin', 'linkedin profile', 'linkedin url'])) {
      return candidate.personal.linkedin || '';
    }
    if (this.matches(label, ['github', 'github profile', 'github url'])) {
      return candidate.personal.github || '';
    }
    if (this.matches(label, ['portfolio', 'website', 'personal site', 'personal website', 'blog'])) {
      return candidate.personal.website || candidate.personal.github || '';
    }

    // 6. Employment & Notice Period
    if (this.matches(label, ['current company', 'current employer', 'present employer', 'organization'])) {
      return candidate.work?.currentEmployer;
    }
    if (this.matches(label, ['current title', 'current job title', 'current position'])) {
      return candidate.work?.currentTitle;
    }
    if (this.matches(label, ['notice period', 'availability', 'how soon can you start', 'start date'])) {
      const notice = candidate.work?.noticePeriod;
      if (!notice) return undefined;
      return this.matchOption(options, notice, ['immediate', '2 weeks', '1 month', '30 days']) ?? notice;
    }
    if (this.matches(label, ['years of experience', 'total experience', 'overall experience'])) {
      const yoe = candidate.work?.yearsOfExperience;
      if (yoe === undefined) return undefined;
      return this.matchOption(options, String(yoe), [`${yoe}`, `${yoe}+`]) ?? yoe;
    }
    if (this.matches(label, ['salary expectation', 'desired salary', 'expected compensation', 'expected ctc', 'current compensation', 'current ctc'])) {
      return candidate.work?.expectedSalary;
    }

    // 7. Relocation & Background Attestations
    if (this.matches(label, ['willing to relocate', 'relocate', 'relocation'])) {
      if (candidate.answersBank?.['relocation']) {
        return candidate.answersBank['relocation'];
      }
      return undefined;
    }

    // 8. Answers Bank semantic lookup
    if (candidate.answersBank) {
      for (const [key, val] of Object.entries(candidate.answersBank)) {
        if (label.includes(key.toLowerCase()) || key.toLowerCase().includes(label)) {
          if (options?.length) {
            return this.matchOption(options, val) ?? val;
          }
          return val;
        }
      }
    }

    // 9. Free-text Summary / Tell us about yourself
    if (this.matches(label, ['about you', 'cover letter', 'summary', 'introduce yourself', 'why are you interested', 'why this role'])) {
      return candidate.personal.summary || candidate.personal.about;
    }

    return undefined;
  }

  /**
   * Matches string against a list of search tokens using word boundary matching.
   */
  private static matches(text: string, tokens: string[]): boolean {
    return tokens.some((t) => {
      const escaped = t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      return new RegExp(`\\b${escaped}\\b`, 'i').test(text);
    });
  }

  /**
   * Matches a target string against available select options.
   */
  static matchOption(
    options: QuestionOption[] | undefined,
    preferred: string,
    fallbackSubstrings: string[] = [],
  ): string | number | undefined {
    if (!options || options.length === 0) return undefined;

    const normPref = preferred.toLowerCase().trim();

    // Exact label match
    const exact = options.find((o) => o.label.toLowerCase().trim() === normPref);
    if (exact) return exact.value;

    // Substring in label
    const sub = options.find((o) => o.label.toLowerCase().includes(normPref) || normPref.includes(o.label.toLowerCase()));
    if (sub) return sub.value;

    // Fallback search tokens
    for (const token of fallbackSubstrings) {
      const match = options.find((o) => o.label.toLowerCase().includes(token));
      if (match) return match.value;
    }

    return undefined;
  }

  /**
   * Picks a safe default for required dropdowns/radios when no answer is found.
   */
  static pickSafeOptionDefault(questionLabel: string, options: QuestionOption[]): string | number {
    const q = questionLabel.toLowerCase();

    // For questions asking about restrictions, violations, or past issues -> default to "No"
    if (q.includes('restriction') || q.includes('violation') || q.includes('felony') || q.includes('agreement') || q.includes('worked at')) {
      const noOpt = options.find((o) => /^(no|false|0)$/i.test(o.label.trim()) || o.label.toLowerCase().startsWith('no'));
      if (noOpt) return noOpt.value;
    }

    // For EEO / voluntary disclosures -> default to Decline
    const decline = options.find((o) => /decline|prefer not|wish not|not to disclose/i.test(o.label));
    if (decline) return decline.value;

    // For yes/no questions -> check context
    if (q.includes('authorized') || q.includes('eligible') || q.includes('consent') || q.includes('agree')) {
      const yesOpt = options.find((o) => /^(yes|true|1)$/i.test(o.label.trim()) || o.label.toLowerCase().startsWith('yes'));
      if (yesOpt) return yesOpt.value;
    }

    // Default to the first available option
    return options[0].value;
  }
}
