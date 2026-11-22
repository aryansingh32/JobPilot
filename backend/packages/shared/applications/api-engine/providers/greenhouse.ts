import { BaseAtsProvider } from './base.js';
import type { AtsApiType, JobTarget, CandidateProfile, ApiSubmissionResult, QuestionDefinition, QuestionOption } from '../types.js';
import { QuestionResolver } from '../resolver.js';
import { createHash } from 'crypto';

interface GreenhouseQuestionRaw {
  description?: string | null;
  label: string;
  required: boolean;
  fields: Array<{
    name: string;
    type: string;
    values?: Array<{ label: string; value: string | number }>;
  }>;
}

export class GreenhouseApiProvider extends BaseAtsProvider {
  readonly name = 'Greenhouse API Engine';
  readonly atsType: AtsApiType = 'greenhouse';

  canHandle(target: JobTarget): boolean {
    if (target.atsType === 'greenhouse') return true;
    try {
      const u = new URL(target.url);
      return /(^|\.)greenhouse\.io$/.test(u.hostname);
    } catch {
      return false;
    }
  }

  /**
   * Fetches the dynamic question schema directly from Greenhouse's public Job Board API.
   */
  async fetchSchema(target: JobTarget): Promise<QuestionDefinition[]> {
    const { boardToken, jobId } = this.extractTokens(target);
    if (!boardToken || !jobId) return [];

    try {
      const url = `https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(boardToken)}/jobs/${encodeURIComponent(jobId)}?questions=true`;
      const res = await fetch(url, {
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
        signal: AbortSignal.timeout(10_000),
      });

      if (!res.ok) return [];
      const data = (await res.json()) as { questions?: GreenhouseQuestionRaw[] };
      if (!Array.isArray(data.questions)) return [];

      return data.questions.map((q, idx) => ({
        id: q.fields[0]?.name || `q_${idx}`,
        label: this.decodeHtml(q.label),
        required: q.required,
        description: q.description ? this.decodeHtml(q.description) : null,
        fields: q.fields.map((f) => ({
          name: f.name,
          type: f.type,
          values: Array.isArray(f.values)
            ? f.values.map((v) => ({ label: this.decodeHtml(v.label), value: v.value }))
            : undefined,
        })),
      }));
    } catch {
      return [];
    }
  }

  /**
   * Submits candidate application directly to Greenhouse via multipart/form-data.
   */
  async submit(target: JobTarget, candidate: CandidateProfile): Promise<ApiSubmissionResult> {
    const start = Date.now();
    const { boardToken, jobId } = this.extractTokens(target);

    if (!boardToken || !jobId) {
      return {
        success: false,
        provider: this.name,
        submissionState: 'failed',
        durationMs: Date.now() - start,
        error: `Could not extract Greenhouse board token and job ID from URL: ${target.url}`,
      };
    }

    // 1. Fetch dynamic question schema
    const questions = await this.fetchSchema(target);

    // 2. Strict client-side pre-flight validation (Greenhouse Boards API does not validate required fields server-side)
    const resolution = QuestionResolver.resolveAllDetailed(questions, candidate, target.country);
    if (resolution.requiresUserAction) {
      return {
        success: false,
        provider: this.name,
        submissionState: 'requires_user_action',
        requiresUserAction: true,
        unresolvedQuestions: resolution.unresolvedRequired,
        durationMs: Date.now() - start,
        error: `Greenhouse application requires applicant confirmation for mandatory questions: ${resolution.unresolvedRequired.map((q) => q.label).join(', ')}`,
      };
    }
    const resolvedAnswers = resolution.answers;

    // 3. Assemble multipart FormData
    const formData = new FormData();
    formData.append('id', String(jobId));
    formData.append('first_name', candidate.personal.firstName);
    formData.append('last_name', candidate.personal.lastName);
    formData.append('email', candidate.personal.email);
    if (candidate.personal.phone) {
      formData.append('phone', candidate.personal.phone);
    }

    // Attach resume file
    const resumeBlob = new Blob([new Uint8Array(candidate.resume.buffer)], { type: candidate.resume.mimeType || 'application/pdf' });
    formData.append('resume', resumeBlob, candidate.resume.fileName || 'resume.pdf');

    // Attach cover letter if present
    if (candidate.coverLetter?.buffer) {
      const clBlob = new Blob([new Uint8Array(candidate.coverLetter.buffer)], { type: 'application/pdf' });
      formData.append('cover_letter', clBlob, candidate.coverLetter.fileName || 'cover_letter.pdf');
    } else if (candidate.coverLetter?.text) {
      formData.append('cover_letter_text', candidate.coverLetter.text);
    }

    // Attach custom questions
    for (const [key, value] of Object.entries(resolvedAnswers)) {
      if (['first_name', 'last_name', 'email', 'phone', 'resume', 'cover_letter'].includes(key)) continue;
      formData.append(key, String(value));
    }


    const submittedPayloadSnapshot: Record<string, unknown> = {
      firstName: candidate.personal.firstName,
      lastName: candidate.personal.lastName,
      email: candidate.personal.email,
      phone: candidate.personal.phone,
      resume: candidate.resume.fileName,
      resolvedAnswersCount: Object.keys(resolvedAnswers).length,
      answers: resolvedAnswers,
    };

    // 4. Send request
    // Only the documented Job Board API endpoint is permitted here. The
    // employer board website route is a browser surface, not a supported API.
    const postUrls = [
      `https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(boardToken)}/jobs/${encodeURIComponent(jobId)}`,
    ];

    let lastError = '';
    let lastStatusCode = 0;

    for (const postUrl of postUrls) {
      try {
        const res = await fetch(postUrl, {
          method: 'POST',
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
            'Accept': 'application/json, text/html, */*',
            'Origin': 'https://job-boards.greenhouse.io',
            'Referer': `https://job-boards.greenhouse.io/${boardToken}/jobs/${jobId}`,
          },
          body: formData,
          redirect: 'manual',
          signal: AbortSignal.timeout(20_000),
        });

        lastStatusCode = res.status;

        // Greenhouse redirects (302/303) on successful submission to /confirmation
        if (res.status === 200 || res.status === 201 || res.status === 302 || res.status === 303) {
          const location = res.headers.get('location') || '';
          const confirmationMatch = location.match(/confirmation\/([a-zA-Z0-9-]+)/)?.[1];
          const confirmationId = confirmationMatch || undefined;
          const submissionState = 'submission_accepted';

          const receiptHash = createHash('sha256')
            .update(`${boardToken}:${jobId}:${candidate.personal.email}:${confirmationId || 'ack'}:${Date.now()}`)
            .digest('hex');

          return {
            success: true,
            provider: this.name,
            submissionState,
            statusCode: res.status,
            confirmationId,
            referenceNumber: confirmationId,
            receiptHash,
            durationMs: Date.now() - start,
            submittedPayload: submittedPayloadSnapshot,
          };
        }

        const responseText = await res.text().catch(() => '');
        lastError = `HTTP ${res.status}: ${responseText.slice(0, 300)}`;

        // Explicit rejection from Greenhouse server: don't retry alternative url
        if (res.status === 422 || res.status === 400) {
          break;
        }
      } catch (err) {
        lastError = (err as Error).message;
      }
    }

    return {
      success: false,
      provider: this.name,
      submissionState: 'failed',
      statusCode: lastStatusCode,
      durationMs: Date.now() - start,
      error: lastError || 'Greenhouse API submission rejected form',
      submittedPayload: submittedPayloadSnapshot,
    };
  }

  private extractTokens(target: JobTarget): { boardToken: string | null; jobId: string | null } {
    if (target.boardToken && target.externalId) {
      return { boardToken: target.boardToken, jobId: target.externalId };
    }

    try {
      const u = new URL(target.url);
      const seg = u.pathname.split('/').filter(Boolean);

      // e.g. /gitlab/jobs/8638232002
      if (seg.length >= 3 && seg[1] === 'jobs') {
        return { boardToken: seg[0], jobId: seg[2] };
      }
      // e.g. boards.greenhouse.io/gitlab/jobs/8638232002
      if (seg.length >= 2 && /^\d+$/.test(seg[1])) {
        return { boardToken: seg[0], jobId: seg[1] };
      }
      const qJob = u.searchParams.get('gh_jid') || u.searchParams.get('token');
      const qFor = u.searchParams.get('for') || seg[0];
      if (qFor && qJob) {
        return { boardToken: qFor, jobId: qJob };
      }
    } catch {}

    return { boardToken: target.boardToken || null, jobId: target.externalId || null };
  }
}
