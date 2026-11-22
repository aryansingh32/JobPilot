import type { AtsApiType, JobTarget, CandidateProfile, ApiSubmissionResult, QuestionDefinition } from '../types.js';

export abstract class BaseAtsProvider {
  abstract readonly name: string;
  abstract readonly atsType: AtsApiType;

  /**
   * Evaluates if this provider can handle the given target URL or ATS type.
   */
  abstract canHandle(target: JobTarget): boolean;

  /**
   * Dynamically inspects the job posting to extract custom questions, fields, and options.
   */
  abstract fetchSchema(target: JobTarget): Promise<QuestionDefinition[]>;

  /**
   * Executes the direct API application submission.
   */
  abstract submit(target: JobTarget, candidate: CandidateProfile): Promise<ApiSubmissionResult>;

  /**
   * Utility helper to safely decode HTML entities.
   */
  protected decodeHtml(str?: string | null): string {
    if (!str) return '';
    return str
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#039;/g, "'")
      .replace(/&#39;/g, "'");
  }
}

