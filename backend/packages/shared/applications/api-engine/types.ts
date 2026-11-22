/**
 * Types for the Direct ATS API Application Engine.
 * Enables zero-cost, sub-second, highly resilient form submissions
 * across Greenhouse, Lever, Ashby, SmartRecruiters, Workable, and Recruitee.
 */

export type AtsApiType =
  | 'greenhouse'
  | 'lever'
  | 'ashby'
  | 'smartrecruiters'
  | 'workable'
  | 'recruitee';

export interface CandidateEducation {
  school: string;
  degree?: string;
  field?: string;
  start?: string;
  end?: string;
  current?: boolean;
  grade?: string;
}

export interface CandidateExperience {
  company: string;
  title: string;
  location?: string;
  start?: string;
  end?: string;
  current?: boolean;
  highlights?: string[];
}

export interface CandidateEeo {
  gender?: string; // 'Male' | 'Female' | 'Decline To Self Identify'
  race?: string; // 'White' | 'Asian' | 'Black or African American' | 'Hispanic or Latino' | 'Decline To Self Identify'
  veteranStatus?: string; // 'I am not a protected veteran' | 'I don\'t wish to answer'
  disabilityStatus?: string; // 'No, I don\'t have a disability' | 'I don\'t wish to answer'
  declineAll?: boolean;
}

export interface CandidateProfile {
  personal: {
    fullName: string;
    firstName: string;
    lastName: string;
    email: string;
    phone?: string;
    city?: string;
    state?: string;
    country?: string;
    address?: string;
    postalCode?: string;
    linkedin?: string;
    github?: string;
    website?: string;
    summary?: string;
    about?: string;
  };
  work?: {
    currentTitle?: string;
    currentEmployer?: string;
    experienceLevel?: string;
    noticePeriod?: string;
    expectedSalary?: string;
    currentSalary?: string;
    yearsOfExperience?: number;
  };
  authorization?: {
    statement?: string;
    needsSponsorship?: boolean;
    authorizedCountries?: string[];
  };
  education?: CandidateEducation[];
  experience?: CandidateExperience[];
  skills?: string[];
  answersBank?: Record<string, string>;
  eeo?: CandidateEeo;
  resume: {
    buffer: Buffer;
    fileName: string;
    mimeType?: string;
  };
  coverLetter?: {
    buffer?: Buffer;
    text?: string;
    fileName?: string;
  };
}

export interface JobTarget {
  jobId?: string | null;
  url: string;
  title: string;
  company?: string | null;
  country?: string | null;
  atsType?: string | null;
  boardToken?: string | null;
  externalId?: string | null;
  skills?: string[];
  summary?: string;
}

export interface QuestionOption {
  label: string;
  value: string | number;
}

export interface QuestionField {
  name: string;
  type: string;
  values?: QuestionOption[];
}

export interface QuestionDefinition {
  id: string;
  label: string;
  required: boolean;
  description?: string | null;
  fields: QuestionField[];
}

export type SubmissionState =
  | 'simulated'
  | 'submission_accepted'
  | 'verified'
  | 'requires_user_action'
  | 'failed';

export interface ApiSubmissionResult {
  success: boolean;
  provider: string;
  submissionState: SubmissionState;
  requiresUserAction?: boolean;
  unresolvedQuestions?: QuestionDefinition[];
  statusCode?: number;
  confirmationId?: string;
  referenceNumber?: string;
  receiptUrl?: string;
  receiptHash?: string;
  durationMs: number;
  timings?: {
    tSchemaFetchMs?: number;
    tResolutionMs?: number;
    tPayloadAssemblyMs?: number;
    tNetworkPostMs?: number;
    tTotalMs?: number;
  };
  submittedPayload?: Record<string, unknown>;
  error?: string;
  rawResponse?: unknown;
}

export interface BulkApplyItem {
  target: JobTarget;
  result?: ApiSubmissionResult;
}

export interface BulkApplyReport {
  total: number;
  succeeded: number;
  failed: number;
  durationMs: number;
  items: Array<{
    target: JobTarget;
    result: ApiSubmissionResult;
  }>;
}

