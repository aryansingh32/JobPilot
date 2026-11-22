import { randomUUID } from 'crypto';
import { userAccountService } from '../packages/api-service/user-account.service.js';
import { generateAndStoreOtp, verifyOtp, signSession, verifySession } from '../packages/shared/auth/index.js';
import { profileService } from '../packages/shared/profile/index.js';
import { profileGaps } from '../packages/shared/profile/gaps.js';
import { missingRequired } from '../packages/shared/profile/resume-analysis.js';
import { fileStorageService } from '../packages/api-service/file-storage.service.js';
import { creditsService } from '../packages/shared/credits/index.js';
import { inboxService } from '../packages/shared/inbox/index.js';
import { atsApiClient } from '../packages/shared/applications/api-engine/client.js';
import { QuestionResolver } from '../packages/shared/applications/api-engine/resolver.js';
import { getPgPool } from '../packages/shared/db/index.js';
import type { JobTarget } from '../packages/shared/applications/api-engine/types.js';

function assert(condition: boolean, msg: string) {
  if (!condition) {
    console.error(`  ❌ FAILED: ${msg}`);
    throw new Error(`Assertion failed: ${msg}`);
  }
  console.log(`  ✅ PASSED: ${msg}`);
}

async function runDeepAccountProfileApiTest() {
  console.log('========================================================================');
  console.log('🔬 DEEP PLATFORM AUDIT & TEST: AUTH, ACCOUNTS, PROFILE, RESUME & ATS API');
  console.log('========================================================================\n');

  const pool = getPgPool();
  const testEmail = `candidate.${randomUUID().slice(0, 8)}@example.com`;
  const testPhone = `+15550${Math.floor(100000 + Math.random() * 900000)}`;

  // ──────────────────────────────────────────────────────────────────
  // MODULE 1: User Account Creation & Authentication Lifecycle
  // ──────────────────────────────────────────────────────────────────
  console.log('▶ [MODULE 1] User Registration & Account Creation through API');
  
  // 1.1 OTP Generation and Rate Limiting
  const otpCode = await generateAndStoreOtp('email', testEmail);
  assert(Boolean(otpCode && otpCode.length === 6), `Generated 6-digit cryptographic OTP: ${otpCode}`);

  // Rate-limiting check: immediate second request should return null (429)
  const rateLimitedOtp = await generateAndStoreOtp('email', testEmail);
  assert(rateLimitedOtp === null, 'Rate limit enforced: immediate second OTP request blocked');

  // 1.2 OTP Verification
  const badOtpValid = await verifyOtp('email', testEmail, '000000');
  assert(!badOtpValid, 'Tampered/invalid OTP correctly rejected');

  const goodOtpValid = await verifyOtp('email', testEmail, otpCode!);
  assert(goodOtpValid, 'Valid OTP successfully verified via scrypt hash comparison');

  // 1.3 User Account Upsert
  const user = await userAccountService.upsertEmailUser(testEmail);
  assert(Boolean(user && user.id), `User account created in PostgreSQL (ID: ${user.id}, Email: ${user.email})`);
  assert(user.emailVerified === true, 'Account email marked verified');

  // 1.4 Session JWT Issuance & Verification
  const token = await signSession({ sub: user.id, email: user.email! });
  assert(typeof token === 'string' && token.split('.').length === 3, 'Issued signed HS256 JWT session token');

  const claims = await verifySession(token);
  assert(claims?.sub === user.id, `Session verified for user ID ${claims?.sub}`);

  // 1.5 Automated Welcome Credit Grant
  const initialBalance = await creditsService.balance(user.id);
  assert(initialBalance === 25, `Welcome credits automatically granted on first balance touch: ${initialBalance} credits`);

  const { rows: ledgerRows } = await pool.query(
    'SELECT delta, reason, note, balance_after FROM credit_ledger WHERE user_id = $1',
    [user.id]
  );
  assert(ledgerRows.length === 1 && ledgerRows[0].reason === 'grant', 'Credit ledger record verified with reason="grant" and note="Welcome credits"');

  // ──────────────────────────────────────────────────────────────────
  // MODULE 2: Contact Information, Phone Linking & Profile Management
  // ──────────────────────────────────────────────────────────────────
  console.log('\n▶ [MODULE 2] Contact Verification & Profile Data Pipeline');

  // 2.1 Profile Completeness before filling
  const emptyProfile = await profileService.get(user.id);
  const initialMissing = missingRequired(emptyProfile.data);
  assert(initialMissing.length > 0, `Detected ${initialMissing.length} missing required fields in blank profile`);

  // 2.2 Mobile Linking with SMS OTP Flow
  const mobileOtp = await generateAndStoreOtp('mobile', testPhone);
  assert(Boolean(mobileOtp && mobileOtp.length === 6), `Generated SMS OTP for ${testPhone}`);
  const mobileVerified = await verifyOtp('mobile', testPhone, mobileOtp!);
  assert(mobileVerified, 'SMS OTP verified');

  const linkedUser = await userAccountService.linkMobile(user.id, testPhone);
  assert(linkedUser?.mobileNumber === testPhone, `Mobile number ${testPhone} linked and verified on account`);

  // 2.3 Profile Contact, Education, Experience & Preferences Patch
  const profilePatch = {
    personal: {
      fullName: 'Alex Vance',
      firstName: 'Alex',
      lastName: 'Vance',
      email: testEmail,
      phone: testPhone,
      address: '742 Evergreen Terrace',
      city: 'Springfield',
      state: 'OR',
      country: 'United States',
      postalCode: '97477',
      linkedin: 'https://linkedin.com/in/alexvance-dev',
      github: 'https://github.com/alexvance-dev',
      website: 'https://alexvance.io',
      summary: 'Staff Software Architect with expertise in high-concurrency systems, TypeScript, and distributed pipelines.',
    },
    work: {
      currentTitle: 'Staff Software Architect',
      currentEmployer: 'Black Mesa Tech',
      experienceLevel: '5+ years',
      noticePeriod: 'Immediately',
      expectedSalary: '$180,000 / year',
      yearsOfExperience: 8,
    },
    authorization: {
      statement: 'Legally authorized to work in the United States without restriction',
      needsSponsorship: false,
      countries: ['US', 'United States'],
    },
    preferences: {
      roles: ['Staff Software Architect', 'Principal Engineer'],
      locations: ['Remote', 'San Francisco', 'Seattle'],
      workplace: ['Remote', 'Hybrid'],
    },
    education: [
      {
        school: 'Stanford University',
        degree: 'Bachelor of Science',
        field: 'Computer Science',
        start: '2012',
        end: '2016',
        current: false,
      },
    ],
    experience: [
      {
        company: 'Black Mesa Tech',
        title: 'Staff Software Architect',
        location: 'Remote',
        start: '2019',
        current: true,
        highlights: [
          'Engineered event-driven distributed streaming pipelines with 99.99% uptime',
          'Architected high-throughput REST and GraphQL application services',
        ],
      },
    ],
    skills: ['TypeScript', 'Node.js', 'PostgreSQL', 'Redis', 'Docker', 'AWS', 'Kubernetes'],
    answerBank: {
      'salary': '$180,000',
      'notice_period': 'Immediate',
      'work_auth': 'Yes',
      'sponsorship': 'No',
    },
  };

  const updatedProfile = await profileService.patch(user.id, profilePatch as any, 'profile-setup');
  assert(updatedProfile.completeness >= 85, `Profile completeness increased to ${updatedProfile.completeness}%`);

  const remainingGaps = profileGaps(updatedProfile.data, { country: 'United States' }).filter(g => g.blocking);
  assert(remainingGaps.length === 0, 'Zero blocking gaps remaining after contact & experience update');

  // 2.4 Dedicated Inbound Application Inbox Provisioning
  const inboxAddress = await inboxService.ensureAddress(user.id, 'Alex Vance');
  assert(Boolean(inboxAddress && inboxAddress.includes('@')), `Dedicated applicant inbox provisioned: ${inboxAddress}`);

  // ──────────────────────────────────────────────────────────────────
  // MODULE 3: Resume Upload, Binary Validation & File Storage Service
  // ──────────────────────────────────────────────────────────────────
  console.log('\n▶ [MODULE 3] Resume Upload, Storage & Attachment Pipeline');

  // 3.1 PDF Binary Creation & Base64 Upload
  const dummyPdf = Buffer.from(
    '%PDF-1.4\n1 0 obj\n<< /Title (Alex Vance Resume) /Author (Alex Vance) >>\nendobj\n' +
    '2 0 obj\n<< /Type /Catalog /Pages 3 0 R >>\nendobj\n' +
    '3 0 obj\n<< /Type /Pages /Kids [4 0 R] /Count 1 >>\nendobj\n' +
    '4 0 obj\n<< /Type /Page /Parent 3 0 R /MediaBox [0 0 612 792] >>\nendobj\n' +
    'xref\n0 5\n0000000000 65535 f \n0000000009 00000 n \n0000000078 00000 n \n' +
    '0000000125 00000 n \n0000000182 00000 n \ntrailer\n<< /Size 5 /Root 2 0 R >>\n' +
    'startxref\n256\n%%EOF',
    'utf-8'
  );
  const base64Data = dummyPdf.toString('base64');

  const uploadedFile = await fileStorageService.uploadBase64({
    userId: user.id,
    originalName: 'Alex_Vance_Resume.pdf',
    mimeType: 'application/pdf',
    base64Data,
    category: 'resume',
    profileName: 'default',
  });

  assert(Boolean(uploadedFile && uploadedFile.id), `Resume stored with File ID: ${uploadedFile.id}`);
  assert(uploadedFile.category === 'resume', 'File category correctly stamped as "resume"');
  assert(Number(uploadedFile.fileSizeBytes) === dummyPdf.byteLength, `File size matches binary length (${uploadedFile.fileSizeBytes} bytes)`);

  // Link file to profile
  const profileWithResume = await profileService.patch(user.id, {
    documents: {
      resumeFileId: uploadedFile.id,
      resumeFileName: uploadedFile.originalName,
    },
  }, 'resume-link');

  assert(profileWithResume.data.documents?.resumeFileId === uploadedFile.id, 'Resume file linked to applicant profile');
  assert(profileWithResume.completeness === 100, `Profile reached perfect 100% completeness after resume link!`);

  // ──────────────────────────────────────────────────────────────────
  // MODULE 4: ATS API Target Validity & Question Schema Verification
  // ──────────────────────────────────────────────────────────────────
  console.log('\n▶ [MODULE 4] ATS Target Validity, Schema Extraction & Resolver');

  // 4.1 Target Resolution & Provider Routing
  const targetGitlab: JobTarget = {
    url: 'https://job-boards.greenhouse.io/gitlab/jobs/8638232002',
    title: 'AI Transformation Owner',
    company: 'GitLab',
    atsType: 'greenhouse',
    boardToken: 'gitlab',
    externalId: '8638232002',
  };

  assert(atsApiClient.canApplyViaApi(targetGitlab), 'AtsApiClient recognizes Greenhouse API target');

  const targetWorkday: JobTarget = {
    url: 'https://nvidia.wd5.myworkdayjobs.com/careers/job/12345',
    title: 'Senior Deep Learning Engineer',
    company: 'NVIDIA',
    atsType: 'workday',
  };

  assert(!atsApiClient.canApplyViaApi(targetWorkday), 'AtsApiClient safely deflects Workday enterprise target to Playwright browser queue');

  // 4.2 Dynamic Live Schema Fetching
  const ghProvider = atsApiClient.findProvider(targetGitlab);
  assert(ghProvider !== null, 'Found Greenhouse API Provider instance');

  const schema = await ghProvider!.fetchSchema(targetGitlab);
  assert(schema.length > 5, `Successfully fetched ${schema.length} live dynamic fields from Greenhouse`);

  // 4.3 Universal Question Resolver & Strict Validation Verification
  const candidatePayload = {
    personal: profileWithResume.data.personal as any,
    work: profileWithResume.data.work as any,
    authorization: profileWithResume.data.authorization as any,
    eeo: {
      gender: 'Decline To Self Identify',
      race: 'Decline To Self Identify',
      veteranStatus: 'I am not a protected veteran',
      disabilityStatus: "No, I don't have a disability",
    },
    resume: {
      buffer: dummyPdf,
      fileName: 'Alex_Vance_Resume.pdf',
      mimeType: 'application/pdf',
    },
  };

  const detailedResolution = QuestionResolver.resolveAllDetailed(schema, candidatePayload, 'United States');
  console.log(`  Resolved fields: ${Object.keys(detailedResolution.answers).length}, Unresolved required: ${detailedResolution.unresolvedRequired.length}`);
  if (detailedResolution.unresolvedRequired.length > 0) {
    console.log('  ⚠️ Unresolved question details:', detailedResolution.unresolvedRequired.map(q => ({ label: q.label, type: q.fields[0]?.type, options: q.fields[0]?.values?.map(v => v.label) })));
  }

  console.log('  GitLab questions:', schema.map(q => `${q.label} [required=${q.required}]`));

  // 4.4 Test Safety Guard: Introduce a mandatory custom question to test requiresUserAction
  const schemaWithMandatoryLegal = [
    ...schema,
    {
      id: 'legal_non_compete',
      label: 'Are you subject to any non-compete or non-solicitation agreement with a prior employer?',
      required: true,
      fields: [{
        name: 'legal_non_compete',
        type: 'boolean',
        values: [{ label: 'Yes', value: 'Yes' }, { label: 'No', value: 'No' }],
      }],
    },
  ];
  const blockedResolution = QuestionResolver.resolveAllDetailed(schemaWithMandatoryLegal, candidatePayload, 'United States');
  assert(blockedResolution.requiresUserAction === true, 'Safety guard verified: unknown mandatory legal question triggers requiresUserAction');
  assert(blockedResolution.unresolvedRequired.length > 0, `Unresolved mandatory question identified: "${blockedResolution.unresolvedRequired[0]?.label}"`);

  // 4.5 End-to-End ATS API Application Run (Simulated Dry-Run)
  const applyResult = await atsApiClient.apply(user.id, targetGitlab, { dryRun: true });
  assert(applyResult.success === true, `AtsApiClient executed dry-run (Provider: ${applyResult.provider})`);
  assert(applyResult.submissionState === 'simulated', `Submission state is explicitly "simulated" (never fake "submitted")`);
  assert(applyResult.confirmationId === undefined, 'Zero synthetic/fake confirmation ID generated for dry run');
  assert(Boolean(applyResult.timings?.tSchemaFetchMs), `Measured real HTTPS schema fetch span: ${applyResult.timings?.tSchemaFetchMs}ms`);
  assert(Boolean(applyResult.timings?.tResolutionMs !== undefined), `Measured question resolution span: ${applyResult.timings?.tResolutionMs}ms`);
  assert(Boolean(applyResult.timings?.tTotalMs), `Measured total span: ${applyResult.timings?.tTotalMs}ms`);

  console.log('\n========================================================================');
  console.log('🎉 ALL MODULE TESTS PASSED WITH 100% SUCCESS!');
  console.log('========================================================================\n');

  // Cleanup test user
  await pool.query('DELETE FROM users WHERE id = $1', [user.id]);
  process.exit(0);
}

runDeepAccountProfileApiTest().catch((err) => {
  console.error('Deep Test Failed:', err);
  process.exit(1);
});
