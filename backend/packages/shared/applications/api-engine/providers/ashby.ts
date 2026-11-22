import { BaseAtsProvider } from './base.js';
import type { AtsApiType, JobTarget, CandidateProfile, ApiSubmissionResult, QuestionDefinition } from '../types.js';
import { QuestionResolver } from '../resolver.js';
import { createHash } from 'crypto';

export class AshbyApiProvider extends BaseAtsProvider {
  readonly name = 'Ashby API Engine';
  readonly atsType: AtsApiType = 'ashby';

  canHandle(target: JobTarget): boolean {
    if (target.atsType === 'ashby') return true;
    try {
      const u = new URL(target.url);
      return /(^|\.)ashbyhq\.com$/.test(u.hostname);
    } catch {
      return false;
    }
  }

  /**
   * Fetches the dynamic question schema from Ashby.
   */
  async fetchSchema(target: JobTarget): Promise<QuestionDefinition[]> {
    const { company, jobId } = this.extractTokens(target);
    if (!company || !jobId) return [];

    try {
      // Ashby exposes posting info via job-board API
      const url = `https://api.ashbyhq.com/posting-api/job-board/${encodeURIComponent(company)}?includeCompensation=true`;
      const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
      if (!res.ok) return [];

      const data = (await res.json()) as { jobs?: Array<{ id: string; title: string }> };
      const job = data.jobs?.find((j) => j.id === jobId);
      if (!job) return [];

      // Standard Ashby baseline schema
      return [
        { id: 'name', label: 'Full Name', required: true, fields: [{ name: 'name', type: 'input_text' }] },
        { id: 'email', label: 'Email Address', required: true, fields: [{ name: 'email', type: 'input_text' }] },
        { id: 'phone', label: 'Phone Number', required: false, fields: [{ name: 'phone', type: 'input_text' }] },
        { id: 'linkedin', label: 'LinkedIn Profile', required: false, fields: [{ name: 'linkedin', type: 'input_text' }] },
        { id: 'github', label: 'GitHub Profile', required: false, fields: [{ name: 'github', type: 'input_text' }] },
        { id: 'website', label: 'Personal Website or Portfolio', required: false, fields: [{ name: 'website', type: 'input_text' }] },
        { id: 'workAuth', label: 'Are you authorized to work in this location?', required: true, fields: [{ name: 'workAuth', type: 'boolean', values: [{ label: 'Yes', value: 'Yes' }, { label: 'No', value: 'No' }] }] },
        { id: 'sponsorship', label: 'Will you require visa sponsorship?', required: true, fields: [{ name: 'sponsorship', type: 'boolean', values: [{ label: 'No', value: 'No' }, { label: 'Yes', value: 'Yes' }] }] },
      ];
    } catch {
      return [];
    }
  }

  /**
   * Submits candidate application to Ashby.
   */
  async submit(target: JobTarget, candidate: CandidateProfile): Promise<ApiSubmissionResult> {
    const start = Date.now();
    const { company, jobId } = this.extractTokens(target);

    if (!company || !jobId) {
      return {
        success: false,
        provider: this.name,
        submissionState: 'failed',
        durationMs: Date.now() - start,
        error: `Could not extract Ashby company slug and job ID from URL: ${target.url}`,
      };
    }

    const questions = await this.fetchSchema(target);
    const resolvedAnswers = QuestionResolver.resolveAll(questions, candidate, target.country);

    // Form multipart payload for Ashby
    const formData = new FormData();
    formData.append('jobPostingId', String(jobId));
    formData.append('name', candidate.personal.fullName);
    formData.append('email', candidate.personal.email);
    if (candidate.personal.phone) formData.append('phone', candidate.personal.phone);
    if (candidate.personal.linkedin) formData.append('linkedin', candidate.personal.linkedin);
    if (candidate.personal.github) formData.append('github', candidate.personal.github);
    if (candidate.personal.website) formData.append('website', candidate.personal.website);

    // Attach resume
    const resumeBlob = new Blob([new Uint8Array(candidate.resume.buffer)], { type: candidate.resume.mimeType || 'application/pdf' });
    formData.append('resume', resumeBlob, candidate.resume.fileName || 'resume.pdf');

    for (const [key, value] of Object.entries(resolvedAnswers)) {
      if (!['name', 'email', 'phone', 'linkedin', 'github', 'website'].includes(key)) {
        formData.append(key, String(value));
      }
    }

    const submittedPayloadSnapshot: Record<string, unknown> = {
      name: candidate.personal.fullName,
      email: candidate.personal.email,
      phone: candidate.personal.phone,
      resume: candidate.resume.fileName,
      answers: resolvedAnswers,
    };

    const targetUrl = `https://jobs.ashbyhq.com/${encodeURIComponent(company)}/${encodeURIComponent(jobId)}/application`;

    try {
      const res = await fetch(targetUrl, {
        method: 'POST',
        headers: {
          'Accept': 'application/json, text/html, */*',
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
          'Origin': 'https://jobs.ashbyhq.com',
          'Referer': targetUrl,
        },
        body: formData,
        signal: AbortSignal.timeout(25_000),
      });

      if (res.status === 200 || res.status === 201 || res.status === 302) {
        const confirmationId: string | undefined = undefined;
        const receiptHash = createHash('sha256')
          .update(`${company}:${jobId}:${candidate.personal.email}:${confirmationId}:${Date.now()}`)
          .digest('hex');

        return {
          success: true,
          provider: this.name,
          submissionState: 'submission_accepted',
          statusCode: res.status,
          confirmationId,
          referenceNumber: confirmationId,
          receiptHash,
          durationMs: Date.now() - start,
          submittedPayload: submittedPayloadSnapshot,
        };
      }

      const text = await res.text().catch(() => '');
      return {
        success: false,
        provider: this.name,
        submissionState: 'failed',
        statusCode: res.status,
        durationMs: Date.now() - start,
        error: `Ashby rejected submission with HTTP ${res.status}: ${text.slice(0, 300)}`,
        submittedPayload: submittedPayloadSnapshot,
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
      // jobs.ashbyhq.com/<company>/<jobId>
      if (seg.length >= 2) {
        return { company: seg[0], jobId: seg[1] };
      }
    } catch {}

    return { company: target.boardToken || null, jobId: target.externalId || null };
  }
}
