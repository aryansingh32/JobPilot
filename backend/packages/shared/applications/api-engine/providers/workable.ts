import { BaseAtsProvider } from './base.js';
import type { AtsApiType, JobTarget, CandidateProfile, ApiSubmissionResult, QuestionDefinition } from '../types.js';
import { QuestionResolver } from '../resolver.js';
import { createHash } from 'crypto';

export class WorkableApiProvider extends BaseAtsProvider {
  readonly name = 'Workable API Engine';
  readonly atsType: AtsApiType = 'workable';

  canHandle(target: JobTarget): boolean {
    if (target.atsType === 'workable') return true;
    try {
      const u = new URL(target.url);
      return /(^|\.)workable\.com$/.test(u.hostname);
    } catch {
      return false;
    }
  }

  async fetchSchema(target: JobTarget): Promise<QuestionDefinition[]> {
    return [
      { id: 'firstname', label: 'First Name', required: true, fields: [{ name: 'firstname', type: 'input_text' }] },
      { id: 'lastname', label: 'Last Name', required: true, fields: [{ name: 'lastname', type: 'input_text' }] },
      { id: 'email', label: 'Email', required: true, fields: [{ name: 'email', type: 'input_text' }] },
      { id: 'phone', label: 'Phone', required: false, fields: [{ name: 'phone', type: 'input_text' }] },
    ];
  }

  async submit(target: JobTarget, candidate: CandidateProfile): Promise<ApiSubmissionResult> {
    const start = Date.now();
    const { subdomain, shortcode } = this.extractTokens(target);

    if (!subdomain || !shortcode) {
      return {
        success: false,
        provider: this.name,
        submissionState: 'failed',
        durationMs: Date.now() - start,
        error: `Could not extract Workable subdomain and job shortcode from URL: ${target.url}`,
      };
    }

    const payload = {
      sourced: false,
      candidate: {
        firstname: candidate.personal.firstName,
        lastname: candidate.personal.lastName,
        email: candidate.personal.email,
        phone: candidate.personal.phone || undefined,
        address: candidate.personal.address || candidate.personal.city || undefined,
        summary: candidate.personal.summary || candidate.coverLetter?.text || undefined,
        resume: {
          name: candidate.resume.fileName || 'resume.pdf',
          data: candidate.resume.buffer.toString('base64'),
        },
      },
    };

    const targetUrl = `https://apply.workable.com/api/v3/accounts/${encodeURIComponent(subdomain)}/jobs/${encodeURIComponent(shortcode)}/candidates`;

    try {
      const res = await fetch(targetUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json',
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
          'Origin': 'https://apply.workable.com',
          'Referer': target.url,
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(25_000),
      });

      const resJson = await res.json().catch(() => null) as { id?: string; candidate_id?: string } | null;

      if (res.status === 200 || res.status === 201 || res.status === 202) {
        const candidateId = resJson?.candidate_id || resJson?.id;
        const submissionState = 'submission_accepted';
        const receiptHash = createHash('sha256')
          .update(`${subdomain}:${shortcode}:${candidate.personal.email}:${candidateId}:${Date.now()}`)
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
            name: `${candidate.personal.firstName} ${candidate.personal.lastName}`,
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
        error: `Workable rejected application with HTTP ${res.status}`,
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

  private extractTokens(target: JobTarget): { subdomain: string | null; shortcode: string | null } {
    if (target.boardToken && target.externalId) {
      return { subdomain: target.boardToken, shortcode: target.externalId };
    }

    try {
      const u = new URL(target.url);
      const seg = u.pathname.split('/').filter(Boolean);
      // apply.workable.com/<subdomain>/j/<shortcode>
      if (seg.length >= 3 && seg[1] === 'j') {
        return { subdomain: seg[0], shortcode: seg[2] };
      }
      if (seg.length >= 2) {
        return { subdomain: seg[0], shortcode: seg[1] };
      }
    } catch {}

    return { subdomain: target.boardToken || null, shortcode: target.externalId || null };
  }
}

