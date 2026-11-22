import { BaseAtsProvider } from './base.js';
import type { AtsApiType, JobTarget, CandidateProfile, ApiSubmissionResult, QuestionDefinition } from '../types.js';
import { createHash } from 'crypto';

export class RecruiteeApiProvider extends BaseAtsProvider {
  readonly name = 'Recruitee API Engine';
  readonly atsType: AtsApiType = 'recruitee';

  canHandle(target: JobTarget): boolean {
    if (target.atsType === 'recruitee') return true;
    try {
      const u = new URL(target.url);
      return /(^|\.)recruitee\.com$/.test(u.hostname);
    } catch {
      return false;
    }
  }

  async fetchSchema(target: JobTarget): Promise<QuestionDefinition[]> {
    return [
      { id: 'name', label: 'Name', required: true, fields: [{ name: 'name', type: 'input_text' }] },
      { id: 'email', label: 'Email', required: true, fields: [{ name: 'email', type: 'input_text' }] },
      { id: 'phone', label: 'Phone', required: false, fields: [{ name: 'phone', type: 'input_text' }] },
    ];
  }

  async submit(target: JobTarget, candidate: CandidateProfile): Promise<ApiSubmissionResult> {
    const start = Date.now();
    const { company, offerId } = this.extractTokens(target);

    if (!company || !offerId) {
      return {
        success: false,
        provider: this.name,
        submissionState: 'failed',
        durationMs: Date.now() - start,
        error: `Could not extract Recruitee company and offer ID from URL: ${target.url}`,
      };
    }

    const formData = new FormData();
    formData.append('candidate[name]', candidate.personal.fullName);
    formData.append('candidate[email]', candidate.personal.email);
    if (candidate.personal.phone) {
      formData.append('candidate[phone]', candidate.personal.phone);
    }
    if (candidate.personal.linkedin) {
      formData.append('candidate[social_links][linkedin]', candidate.personal.linkedin);
    }
    if (candidate.personal.github) {
      formData.append('candidate[social_links][github]', candidate.personal.github);
    }
    if (candidate.personal.summary || candidate.coverLetter?.text) {
      formData.append('candidate[cover_letter]', candidate.personal.summary || candidate.coverLetter?.text || '');
    }

    // Attach resume file
    const resumeBlob = new Blob([new Uint8Array(candidate.resume.buffer)], { type: candidate.resume.mimeType || 'application/pdf' });
    formData.append('candidate[cv]', resumeBlob, candidate.resume.fileName || 'resume.pdf');

    const targetUrl = `https://${encodeURIComponent(company)}.recruitee.com/api/offers/${encodeURIComponent(offerId)}/candidates`;

    try {
      const res = await fetch(targetUrl, {
        method: 'POST',
        headers: {
          'Accept': 'application/json',
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
          'Origin': `https://${company}.recruitee.com`,
        },
        body: formData,
        signal: AbortSignal.timeout(25_000),
      });

      const resJson = await res.json().catch(() => null) as { candidate?: { id?: number } } | null;

      if (res.status === 200 || res.status === 201 || (resJson && resJson.candidate)) {
        const candidateId = resJson?.candidate?.id ? String(resJson.candidate.id) : undefined;
        const submissionState = 'submission_accepted';
        const receiptHash = createHash('sha256')
          .update(`${company}:${offerId}:${candidate.personal.email}:${candidateId}:${Date.now()}`)
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
          submittedPayload: {
            name: candidate.personal.fullName,
            email: candidate.personal.email,
            resume: candidate.resume.fileName,
          },
          rawResponse: resJson,
        };
      }

      return {
        success: false,
        provider: this.name,
        submissionState: 'failed',
        statusCode: res.status,
        durationMs: Date.now() - start,
        error: `Recruitee rejected application with HTTP ${res.status}`,
        rawResponse: resJson,
      };
    } catch (err) {
      return {
        success: false,
        provider: this.name,
        submissionState: 'failed',
        durationMs: Date.now() - start,
        error: (err as Error).message,
      };
    }
  }

  private extractTokens(target: JobTarget): { company: string | null; offerId: string | null } {
    if (target.boardToken && target.externalId) {
      return { company: target.boardToken, offerId: target.externalId };
    }

    try {
      const u = new URL(target.url);
      const company = u.hostname.split('.')[0];
      const seg = u.pathname.split('/').filter(Boolean);
      // <company>.recruitee.com/o/<offerId>
      if (seg.length >= 2 && seg[0] === 'o') {
        return { company, offerId: seg[1] };
      }
    } catch {}

    return { company: target.boardToken || null, offerId: target.externalId || null };
  }
}
