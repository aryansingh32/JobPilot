import { BaseAtsProvider } from './base.js';
import type { AtsApiType, JobTarget, CandidateProfile, ApiSubmissionResult, QuestionDefinition } from '../types.js';
import { QuestionResolver } from '../resolver.js';
import { createHash } from 'crypto';

export class SmartRecruitersApiProvider extends BaseAtsProvider {
  readonly name = 'SmartRecruiters API Engine';
  readonly atsType: AtsApiType = 'smartrecruiters';

  canHandle(target: JobTarget): boolean {
    if (target.atsType === 'smartrecruiters') return true;
    try {
      const u = new URL(target.url);
      return /(^|\.)smartrecruiters\.com$/.test(u.hostname);
    } catch {
      return false;
    }
  }

  async fetchSchema(target: JobTarget): Promise<QuestionDefinition[]> {
    return [
      { id: 'firstName', label: 'First Name', required: true, fields: [{ name: 'firstName', type: 'input_text' }] },
      { id: 'lastName', label: 'Last Name', required: true, fields: [{ name: 'lastName', type: 'input_text' }] },
      { id: 'email', label: 'Email', required: true, fields: [{ name: 'email', type: 'input_text' }] },
      { id: 'phoneNumber', label: 'Phone', required: false, fields: [{ name: 'phoneNumber', type: 'input_text' }] },
      { id: 'city', label: 'City', required: false, fields: [{ name: 'city', type: 'input_text' }] },
      { id: 'workAuth', label: 'Are you authorized to work in this location?', required: true, fields: [{ name: 'workAuth', type: 'boolean', values: [{ label: 'Yes', value: 'Yes' }, { label: 'No', value: 'No' }] }] },
    ];
  }

  async submit(target: JobTarget, candidate: CandidateProfile): Promise<ApiSubmissionResult> {
    const start = Date.now();
    const { company, jobId } = this.extractTokens(target);

    if (!company || !jobId) {
      return {
        success: false,
        provider: this.name,
        submissionState: 'failed',
        durationMs: Date.now() - start,
        error: `Could not extract SmartRecruiters company slug and job ID from URL: ${target.url}`,
      };
    }

    const questions = await this.fetchSchema(target);
    const resolvedAnswers = QuestionResolver.resolveAll(questions, candidate, target.country);

    // SmartRecruiters REST API Candidate Payload
    const payload = {
      firstName: candidate.personal.firstName,
      lastName: candidate.personal.lastName,
      email: candidate.personal.email,
      phoneNumber: candidate.personal.phone || undefined,
      location: {
        city: candidate.personal.city || 'San Francisco',
        country: candidate.personal.country || 'United States',
      },
      web: {
        linkedin: candidate.personal.linkedin,
        github: candidate.personal.github,
        website: candidate.personal.website,
      },
      attachments: [
        {
          fileContent: candidate.resume.buffer.toString('base64'),
          fileName: candidate.resume.fileName || 'resume.pdf',
          type: 'RESUME',
        },
      ],
      consent: true,
      answers: resolvedAnswers,
    };

    const submittedPayloadSnapshot: Record<string, unknown> = {
      firstName: candidate.personal.firstName,
      lastName: candidate.personal.lastName,
      email: candidate.personal.email,
      resume: candidate.resume.fileName,
      answers: resolvedAnswers,
    };

    const targetUrl = `https://api.smartrecruiters.com/v1/companies/${encodeURIComponent(company)}/postings/${encodeURIComponent(jobId)}/candidates`;

    try {
      const res = await fetch(targetUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json',
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(25_000),
      });

      const resJson = await res.json().catch(() => null) as { id?: string; candidateId?: string } | null;

      if (res.status === 200 || res.status === 201 || res.status === 202) {
        const candidateId = resJson?.candidateId || resJson?.id;
        const submissionState = 'submission_accepted';
        const receiptHash = createHash('sha256')
          .update(`${company}:${jobId}:${candidate.personal.email}:${candidateId}:${Date.now()}`)
          .digest('hex');

        return {
          success: true,
          provider: this.name,
          submissionState,
          statusCode: res.status,
          confirmationId: candidateId,
          referenceNumber: candidateId,
          receiptHash,
          durationMs: Date.now() - start,
          submittedPayload: submittedPayloadSnapshot,
          rawResponse: resJson,
        };
      }

      return {
        success: false,
        provider: this.name,
        submissionState: 'failed',
        statusCode: res.status,
        durationMs: Date.now() - start,
        error: `SmartRecruiters rejected application with HTTP ${res.status}`,
        submittedPayload: submittedPayloadSnapshot,
        rawResponse: resJson,
      };
    } catch (err) {
      return {
        success: false,
        provider: this.name,
        submissionState: 'failed',
        durationMs: Date.now() - start,
        error: (err as Error).message,
        submittedPayload: submittedPayloadSnapshot,
      };
    }
  }

  private extractTokens(target: JobTarget): { company: string | null; jobId: string | null } {
    if (target.boardToken && target.externalId) {
      return { company: target.boardToken, jobId: target.externalId };
    }

    try {
      const u = new URL(target.url);
      const seg = u.pathname.split('/').filter(Boolean);
      // jobs.smartrecruiters.com/<company>/<jobId>
      if (seg.length >= 2) {
        return { company: seg[0], jobId: seg[1] };
      }
    } catch {}

    return { company: target.boardToken || null, jobId: target.externalId || null };
  }
}

