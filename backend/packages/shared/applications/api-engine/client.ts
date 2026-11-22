import type { JobTarget, CandidateProfile, ApiSubmissionResult, AtsApiType } from './types.js';
import { BaseAtsProvider } from './providers/base.js';
import { GreenhouseApiProvider } from './providers/greenhouse.js';
import { LeverApiProvider } from './providers/lever.js';
import { AshbyApiProvider } from './providers/ashby.js';
import { SmartRecruitersApiProvider } from './providers/smartrecruiters.js';
import { WorkableApiProvider } from './providers/workable.js';
import { RecruiteeApiProvider } from './providers/recruitee.js';
import { QuestionResolver } from './resolver.js';
import { profileService } from '../../profile/index.js';
import { getPgPool } from '../../db/index.js';
import { createLogger } from '../../logger/index.js';

const logger = createLogger('ats-api-client');

export class AtsApiClient {
  private providers: BaseAtsProvider[] = [
    new GreenhouseApiProvider(),
    new LeverApiProvider(),
    new AshbyApiProvider(),
    new SmartRecruitersApiProvider(),
    new WorkableApiProvider(),
    new RecruiteeApiProvider(),
  ];

  /**
   * Identifies which direct API provider can handle this job target.
   */
  findProvider(target: JobTarget): BaseAtsProvider | null {
    return this.providers.find((p) => p.canHandle(target)) || null;
  }

  /**
   * Returns true if the target can be applied to directly via REST/multipart API.
   */
  canApplyViaApi(target: JobTarget): boolean {
    // Provider recognition is not live-submission authorization. None of the
    // six adapters currently has a complete, employer-authorized, independently
    // verified production path, so route applications through the reviewed
    // browser workflow until a provider adapter is explicitly certified.
    void target;
    return false;
  }

  /**
   * Executes a direct, sub-second API application on behalf of a user.
   */
  async apply(
    userId: string,
    target: JobTarget,
    options: {
      resumeBuffer?: Buffer;
      resumeFileName?: string;
      coverLetterText?: string;
      dryRun?: boolean;
    } = {},
  ): Promise<ApiSubmissionResult> {
    const provider = this.findProvider(target);
    if (!provider) {
      return {
        success: false,
        provider: 'none',
        submissionState: 'failed',
        durationMs: 0,
        error: `No direct API provider available for ATS type "${target.atsType}" or URL "${target.url}"`,
      };
    }

    if (!options.dryRun) {
      return {
        success: false,
        provider: provider.name,
        submissionState: 'failed',
        durationMs: 0,
        error: 'Direct ATS submission is disabled until this adapter has authorized credentials and independent provider-side verification.',
      };
    }

    const t0 = performance.now();

    // 1. Fetch user profile from database
    const profile = await profileService.get(userId);
    const p = profile.data;

    // 2. Resolve resume binary
    let resumeBuffer = options.resumeBuffer;
    let resumeFileName = options.resumeFileName || p.documents?.resumeFileName || 'Resume.pdf';

    if (!resumeBuffer) {
      resumeBuffer = await this.loadResumeBuffer(userId, p.documents?.resumeFileId);
    }

    // 3. Assemble typed CandidateProfile
    const fullName = p.personal?.fullName
      || [p.personal?.firstName, p.personal?.lastName].filter(Boolean).join(' ');
    const firstName = p.personal?.firstName || fullName.split(' ')[0] || '';
    const lastName = p.personal?.lastName || fullName.split(' ').slice(1).join(' ');

    const candidate: CandidateProfile = {
      personal: {
        fullName,
        firstName,
        lastName,
        email: p.personal?.email || '',
        phone: p.personal?.phone,
        city: p.personal?.city,
        state: p.personal?.state,
        country: p.personal?.country,
        address: p.personal?.address,
        postalCode: p.personal?.postalCode,
        linkedin: p.personal?.linkedin,
        github: p.personal?.github,
        website: p.personal?.website,
        summary: p.personal?.summary,
        about: p.about,
      },
      work: {
        currentTitle: p.work?.currentTitle,
        currentEmployer: p.work?.currentEmployer,
        experienceLevel: p.work?.experienceLevel,
        noticePeriod: p.work?.noticePeriod,
        expectedSalary: p.work?.expectedSalary,
        currentSalary: p.work?.currentSalary,
        yearsOfExperience: p.work?.yearsOfExperience,
      },
      authorization: {
        statement: p.authorization?.statement,
        needsSponsorship: p.authorization?.needsSponsorship,
        authorizedCountries: p.authorization?.countries,
      },
      education: p.education?.map((e) => ({
        school: e.school,
        degree: e.degree,
        field: e.field,
        start: e.start,
        end: e.end,
        current: e.current,
        grade: e.grade,
      })),
      experience: p.experience?.map((e) => ({
        company: e.company,
        title: e.title,
        location: e.location,
        start: e.start,
        end: e.end,
        current: e.current,
        highlights: e.highlights,
      })),
      skills: p.skills,
      answersBank: (p.answerBank as Record<string, string>) || {},
      eeo: undefined,
      resume: {
        buffer: resumeBuffer,
        fileName: resumeFileName,
        mimeType: 'application/pdf',
      },
      coverLetter: options.coverLetterText ? { text: options.coverLetterText } : undefined,
    };

    const missingCore = [
      !candidate.personal.firstName && 'First name',
      !candidate.personal.lastName && 'Last name',
      !candidate.personal.email && 'Email',
      !candidate.resume.buffer?.byteLength && 'Resume',
    ].filter((value): value is string => Boolean(value));
    if (missingCore.length) {
      const unresolvedQuestions = missingCore.map((label, index) => ({
        id: `core-${index}`,
        label,
        required: true,
        fields: [],
      }));
      return {
        success: false,
        provider: provider.name,
        submissionState: 'requires_user_action',
        requiresUserAction: true,
        unresolvedQuestions,
        durationMs: Math.round(performance.now() - t0),
        error: `Applicant input required for mandatory fields: ${missingCore.join(', ')}`,
      };
    }

    // 4. Fetch dynamic question schema from provider over HTTPS
    const tSchemaStart = performance.now();
    const schema = await provider.fetchSchema(target);
    const tSchemaFetchMs = Math.round(performance.now() - tSchemaStart);

    // 5. Strict client-side validation & Question Resolution
    const tResStart = performance.now();
    const resolution = QuestionResolver.resolveAllDetailed(schema, candidate, target.country);
    const tResolutionMs = Math.round(performance.now() - tResStart);

    // If unresolved mandatory questions exist, NEVER guess!
    if (resolution.requiresUserAction) {
      logger.warn('api-engine:requires-user-action', {
        unresolvedCount: resolution.unresolvedRequired.length,
      });
      return {
        success: false,
        provider: provider.name,
        submissionState: 'requires_user_action',
        requiresUserAction: true,
        unresolvedQuestions: resolution.unresolvedRequired,
        durationMs: Math.round(performance.now() - t0),
        timings: {
          tSchemaFetchMs,
          tResolutionMs,
          tTotalMs: Math.round(performance.now() - t0),
        },
        error: `Application requires applicant confirmation for mandatory questions: ${resolution.unresolvedRequired.map((q) => q.label).join(', ')}`,
      };
    }

    // 6. Assemble payload preview
    const tPayloadStart = performance.now();
    const submittedPayload: Record<string, unknown> = {
      target,
      fieldsDiscovered: schema.length,
      candidate: {
        fullName: candidate.personal.fullName,
        email: candidate.personal.email,
        phone: candidate.personal.phone,
        resumeName: candidate.resume.fileName,
        resumeBytes: candidate.resume.buffer.byteLength,
      },
      resolvedAnswersCount: Object.keys(resolution.answers).length,
      answers: resolution.answers,
    };
    const tPayloadAssemblyMs = Math.round(performance.now() - tPayloadStart);

    // 7. In dry-run mode: STOP before external mutation!
    if (options.dryRun) {
      const tTotalMs = Math.round(performance.now() - t0);
      logger.info('api-engine:simulated-dry-run-complete', {
        provider: provider.name,
        userId,
        tSchemaFetchMs,
        tResolutionMs,
        tPayloadAssemblyMs,
        tTotalMs,
      });

      return {
        success: true,
        provider: provider.name,
        submissionState: 'simulated',
        durationMs: tTotalMs,
        timings: {
          tSchemaFetchMs,
          tResolutionMs,
          tPayloadAssemblyMs,
          tTotalMs,
        },
        submittedPayload,
      };
    }

    // 8. Submit directly via Provider
    const tPostStart = performance.now();
    logger.info('api-engine:submitting-live', {
      provider: provider.name,
      userId,
      url: target.url,
      ats: target.atsType,
    });

    const result = await provider.submit(target, candidate);
    const tNetworkPostMs = Math.round(performance.now() - tPostStart);
    const tTotalMs = Math.round(performance.now() - t0);

    return {
      ...result,
      timings: {
        tSchemaFetchMs,
        tResolutionMs,
        tPayloadAssemblyMs,
        tNetworkPostMs,
        tTotalMs,
      },
      durationMs: tTotalMs,
    };
  }

  /**
   * Loads the applicant's uploaded resume. Missing files must stop submission.
   */
  private async loadResumeBuffer(userId: string, fileId?: string): Promise<Buffer> {
    if (fileId) {
      try {
        const pool = getPgPool();
        const { rows } = await pool.query('SELECT storage_path FROM user_files WHERE id = $1 AND user_id = $2', [fileId, userId]);
        if (rows[0]?.storage_path) {
          const { readFile } = await import('fs/promises');
          return await readFile(rows[0].storage_path);
        }
      } catch (err) {
        logger.warn('api-engine:loadResumeBuffer-failed', { fileId, error: (err as Error).message });
      }
    }

    return Buffer.alloc(0);
  }
}

export const atsApiClient = new AtsApiClient();
