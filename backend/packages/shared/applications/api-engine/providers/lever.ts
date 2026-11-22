import { BaseAtsProvider } from './base.js';
import type { AtsApiType, JobTarget, CandidateProfile, ApiSubmissionResult, QuestionDefinition } from '../types.js';
import { QuestionResolver } from '../resolver.js';
import { createHash } from 'crypto';

interface LeverPostingDetail {
  id: string;
  text: string;
  categories?: { commitment?: string; location?: string; team?: string };
  cards?: Array<{
    id: string;
    text: string;
    fields?: Array<{
      id: string;
      text: string;
      type: string;
      required?: boolean;
      options?: Array<{ id: string; text: string }>;
    }>;
  }>;
}

export class LeverApiProvider extends BaseAtsProvider {
  readonly name = 'Lever API Engine';
  readonly atsType: AtsApiType = 'lever';

  canHandle(target: JobTarget): boolean {
    if (target.atsType === 'lever') return true;
    try {
      const u = new URL(target.url);
      return /(^|\.)lever\.co$/.test(u.hostname);
    } catch {
      return false;
    }
  }

  /**
   * Fetches the dynamic custom cards / questions schema from Lever.
   */
  async fetchSchema(target: JobTarget): Promise<QuestionDefinition[]> {
    const { company, jobId } = this.extractTokens(target);
    if (!company || !jobId) return [];

    try {
      const url = `https://api.lever.co/v0/postings/${encodeURIComponent(company)}/${encodeURIComponent(jobId)}`;
      const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
      if (!res.ok) return [];

      const data = (await res.json()) as LeverPostingDetail;
      if (!Array.isArray(data.cards)) return [];

      const definitions: QuestionDefinition[] = [];
      for (const card of data.cards) {
        if (!Array.isArray(card.fields)) continue;
        for (const f of card.fields) {
          definitions.push({
            id: `cards[${card.id}][${f.id}]`,
            label: this.decodeHtml(f.text || card.text),
            required: f.required ?? false,
            fields: [
              {
                name: `cards[${card.id}][${f.id}]`,
                type: f.type,
                values: Array.isArray(f.options)
                  ? f.options.map((opt) => ({ label: this.decodeHtml(opt.text), value: opt.text }))
                  : undefined,
              },
            ],
          });
        }
      }

      return definitions;
    } catch {
      return [];
    }
  }

  /**
   * Submits candidate application to Lever via public candidate endpoint.
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
        error: `Could not extract Lever company slug and posting ID from URL: ${target.url}`,
      };
    }

    // 1. Fetch dynamic cards schema
    const questions = await this.fetchSchema(target);

    // 2. Resolve custom answers
    const resolvedAnswers = QuestionResolver.resolveAll(questions, candidate, target.country);

    // 3. Assemble multipart FormData
    const formData = new FormData();
    formData.append('name', candidate.personal.fullName);
    formData.append('email', candidate.personal.email);
    if (candidate.personal.phone) {
      formData.append('phone', candidate.personal.phone);
    }
    if (candidate.work?.currentEmployer) {
      formData.append('org', candidate.work.currentEmployer);
    }
    if (candidate.personal.linkedin) {
      formData.append('urls[LinkedIn]', candidate.personal.linkedin);
    }
    if (candidate.personal.github) {
      formData.append('urls[GitHub]', candidate.personal.github);
    }
    if (candidate.personal.website) {
      formData.append('urls[Portfolio]', candidate.personal.website);
    }
    if (candidate.coverLetter?.text || candidate.personal.summary) {
      formData.append('comments', candidate.coverLetter?.text || candidate.personal.summary || '');
    }

    // Attach resume file
    const resumeBlob = new Blob([new Uint8Array(candidate.resume.buffer)], { type: candidate.resume.mimeType || 'application/pdf' });
    formData.append('resume', resumeBlob, candidate.resume.fileName || 'resume.pdf');

    // Attach custom cards
    for (const [key, value] of Object.entries(resolvedAnswers)) {
      formData.append(key, String(value));
    }

    const submittedPayloadSnapshot: Record<string, unknown> = {
      name: candidate.personal.fullName,
      email: candidate.personal.email,
      phone: candidate.personal.phone,
      resume: candidate.resume.fileName,
      resolvedAnswersCount: Object.keys(resolvedAnswers).length,
      answers: resolvedAnswers,
    };

    // 4. Send POST request
    const postUrl = `https://api.lever.co/v0/postings/${encodeURIComponent(company)}/${encodeURIComponent(jobId)}`;

    try {
      const res = await fetch(postUrl, {
        method: 'POST',
        headers: {
          'Accept': 'application/json',
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
          'Origin': 'https://jobs.lever.co',
          'Referer': `https://jobs.lever.co/${company}/${jobId}`,
        },
        body: formData,
        signal: AbortSignal.timeout(25_000),
      });

      const resBody = await res.json().catch(() => null) as { ok?: boolean; data?: { applicationId?: string }; error?: string } | null;

      if (res.status === 200 || res.status === 201 || (resBody && resBody.ok)) {
        const applicationId = resBody?.data?.applicationId;
        const submissionState = 'submission_accepted';

        const receiptHash = createHash('sha256')
          .update(`${company}:${jobId}:${candidate.personal.email}:${applicationId}:${Date.now()}`)
          .digest('hex');

        return {
          success: true,
          provider: this.name,
          submissionState,
          statusCode: res.status,
          confirmationId: applicationId,
          referenceNumber: applicationId,
          receiptHash,
          durationMs: Date.now() - start,
          submittedPayload: submittedPayloadSnapshot,
          rawResponse: resBody,
        };
      }

      return {
        success: false,
        provider: this.name,
        submissionState: 'failed',
        statusCode: res.status,
        durationMs: Date.now() - start,
        error: resBody?.error || `Lever rejected submission with HTTP ${res.status}`,
        submittedPayload: submittedPayloadSnapshot,
        rawResponse: resBody,
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
      // jobs.lever.co/<company>/<id> or <company>/<id>/apply
      if (seg.length >= 2) {
        return { company: seg[0], jobId: seg[1] };
      }
    } catch {}

    return { company: target.boardToken || null, jobId: target.externalId || null };
  }
}
