import { atsApiClient } from '../packages/shared/applications/api-engine/client.js';
import { bulkApiEngine } from '../packages/shared/applications/api-engine/bulk-engine.js';
import { QuestionResolver } from '../packages/shared/applications/api-engine/resolver.js';
import { GreenhouseApiProvider } from '../packages/shared/applications/api-engine/providers/greenhouse.js';
import { LeverApiProvider } from '../packages/shared/applications/api-engine/providers/lever.js';
import { AshbyApiProvider } from '../packages/shared/applications/api-engine/providers/ashby.js';
import { SmartRecruitersApiProvider } from '../packages/shared/applications/api-engine/providers/smartrecruiters.js';
import { WorkableApiProvider } from '../packages/shared/applications/api-engine/providers/workable.js';
import { RecruiteeApiProvider } from '../packages/shared/applications/api-engine/providers/recruitee.js';
import type { CandidateProfile, JobTarget, QuestionDefinition } from '../packages/shared/applications/api-engine/types.js';

const testCandidate: CandidateProfile = {
  personal: {
    fullName: 'David Miller',
    firstName: 'David',
    lastName: 'Miller',
    email: 'david.miller@example.com',
    phone: '+1-555-0188',
    city: 'New York',
    state: 'NY',
    country: 'United States',
    address: '250 Broadway',
    postalCode: '10007',
    linkedin: 'https://linkedin.com/in/davidmiller',
    github: 'https://github.com/davidmiller',
    website: 'https://davidmiller.dev',
    summary: 'Lead Software Architect with 10+ years specializing in distributed systems and cloud APIs.',
  },
  work: {
    currentTitle: 'Lead Software Architect',
    currentEmployer: 'Global Cloud Systems',
    experienceLevel: 'Staff',
    noticePeriod: '30 days',
    expectedSalary: '$180,000',
    yearsOfExperience: 10,
  },
  authorization: {
    statement: 'Legally authorized to work in US without sponsorship',
    needsSponsorship: false,
    authorizedCountries: ['US', 'United States'],
  },
  answersBank: {
    'system architecture': 'Designed microservices processing 50M requests per day with 99.99% uptime.',
    'relocation': 'Willing to relocate for the right opportunity.',
  },
  eeo: {
    gender: 'Male',
    race: 'White',
    veteranStatus: 'I am not a protected veteran',
    disabilityStatus: "No, I don't have a disability",
  },
  resume: {
    buffer: Buffer.from('%PDF-1.4 Mock Resume Binary Content for David Miller'),
    fileName: 'David_Miller_Architect_Resume.pdf',
    mimeType: 'application/pdf',
  },
};

let passed = 0;
let failed = 0;

function assert(condition: boolean, message: string) {
  if (condition) {
    console.log(`  ✓ ${message}`);
    passed++;
  } else {
    console.error(`  ✗ FAIL: ${message}`);
    failed++;
  }
}

async function runLiveVerification() {
  console.log('\n======================================================');
  console.log('🚀 DIRECT ATS API ENGINE LIVE INTENSE VERIFICATION');
  console.log('======================================================\n');

  // ── TEST 1: QuestionResolver Precision ──
  console.log('Test Suite 1: QuestionResolver Precision & Field Mapping');
  const sampleQuestions: QuestionDefinition[] = [
    { id: '1', label: 'First Name', required: true, fields: [{ name: 'first_name', type: 'input_text' }] },
    { id: '2', label: 'Last Name', required: true, fields: [{ name: 'last_name', type: 'input_text' }] },
    { id: '3', label: 'Email', required: true, fields: [{ name: 'email', type: 'input_text' }] },
    { id: '4', label: 'Phone', required: false, fields: [{ name: 'phone', type: 'input_text' }] },
    {
      id: '5',
      label: 'Are you legally authorized to work in the United States?',
      required: true,
      fields: [
        {
          name: 'work_auth',
          type: 'multi_value_single_select',
          values: [
            { label: 'Yes', value: 'opt_yes' },
            { label: 'No', value: 'opt_no' },
          ],
        },
      ],
    },
    {
      id: '6',
      label: 'Will you now or in the future require visa sponsorship?',
      required: true,
      fields: [
        {
          name: 'sponsorship',
          type: 'multi_value_single_select',
          values: [
            { label: 'Yes', value: 1 },
            { label: 'No', value: 0 },
          ],
        },
      ],
    },
    {
      id: '7',
      label: 'Years of Experience',
      required: true,
      fields: [{ name: 'yoe', type: 'input_text' }],
    },
    {
      id: '8',
      label: 'What is your current notice period?',
      required: true,
      fields: [
        {
          name: 'notice',
          type: 'multi_value_single_select',
          values: [
            { label: 'Immediate', value: 'imm' },
            { label: '30 days / 1 month', value: '30d' },
            { label: '90 days', value: '90d' },
          ],
        },
      ],
    },
  ];

  const resolved = QuestionResolver.resolveAll(sampleQuestions, testCandidate);
  assert(resolved.first_name === 'David', 'First name resolved');
  assert(resolved.last_name === 'Miller', 'Last name resolved');
  assert(resolved.email === 'david.miller@example.com', 'Email resolved');
  assert(resolved.work_auth === 'opt_yes', 'Work authorization mapped to option value');
  assert(resolved.sponsorship === 0, 'Sponsorship mapped to No (0)');
  assert(resolved.yoe === 10, 'Years of experience mapped');
  assert(resolved.notice === '30d', 'Notice period mapped accurately to 30 days');

  // ── TEST 2: Provider Domain Recognition & Token Extraction ──
  console.log('\nTest Suite 2: Provider Recognition & Token Extraction');
  const ghProvider = new GreenhouseApiProvider();
  const leverProvider = new LeverApiProvider();
  const ashbyProvider = new AshbyApiProvider();
  const srProvider = new SmartRecruitersApiProvider();
  const workableProvider = new WorkableApiProvider();
  const recruiteeProvider = new RecruiteeApiProvider();

  assert(ghProvider.canHandle({ url: 'https://job-boards.greenhouse.io/gitlab/jobs/8638232002', title: 'Eng' }), 'Greenhouse URL detected');
  assert(leverProvider.canHandle({ url: 'https://jobs.lever.co/palantir/123-abc', title: 'Eng' }), 'Lever URL detected');
  assert(ashbyProvider.canHandle({ url: 'https://jobs.ashbyhq.com/paraform/0900e03f', title: 'Eng' }), 'Ashby URL detected');
  assert(srProvider.canHandle({ url: 'https://jobs.smartrecruiters.com/Acme/456-dev', title: 'Eng' }), 'SmartRecruiters URL detected');
  assert(workableProvider.canHandle({ url: 'https://apply.workable.com/techco/j/99AABB', title: 'Eng' }), 'Workable URL detected');
  assert(recruiteeProvider.canHandle({ url: 'https://startup.recruitee.com/o/lead-dev', title: 'Eng' }), 'Recruitee URL detected');

  // ── TEST 3: Live Live Greenhouse Schema Inspection ──
  console.log('\nTest Suite 3: Live Greenhouse API Schema Fetching');
  try {
    const gitlabTarget: JobTarget = {
      url: 'https://job-boards.greenhouse.io/gitlab/jobs/8638232002',
      title: 'AI Transformation Owner',
      boardToken: 'gitlab',
      externalId: '8638232002',
      atsType: 'greenhouse',
    };

    const gitlabSchema = await ghProvider.fetchSchema(gitlabTarget);
    assert(gitlabSchema.length > 5, `Fetched ${gitlabSchema.length} live questions from GitLab Greenhouse API`);
    const fnQ = gitlabSchema.find((q) => q.label.toLowerCase().includes('first name'));
    assert(fnQ !== undefined, 'Live Greenhouse schema contains "First Name" field');
    const authQ = gitlabSchema.find((q) => q.label.toLowerCase().includes('sponsorship') || q.label.toLowerCase().includes('authorized'));
    assert(authQ !== undefined, 'Live Greenhouse schema contains work-auth / sponsorship screening question');
  } catch (err) {
    console.warn(`  ⚠️ Live network fetch skipped or offline: ${(err as Error).message}`);
  }

  // ── TEST 4: Unified AtsApiClient Architecture ──
  console.log('\nTest Suite 4: Unified AtsApiClient Dispatcher');
  assert(atsApiClient.canApplyViaApi({ url: 'https://job-boards.greenhouse.io/gitlab/jobs/1', title: 'Eng' }), 'atsApiClient handles Greenhouse');
  assert(atsApiClient.canApplyViaApi({ url: 'https://jobs.lever.co/company/2', title: 'Eng' }), 'atsApiClient handles Lever');
  assert(atsApiClient.canApplyViaApi({ url: 'https://jobs.ashbyhq.com/company/3', title: 'Eng' }), 'atsApiClient handles Ashby');
  assert(!atsApiClient.canApplyViaApi({ url: 'https://nvidia.wd5.myworkdayjobs.com/careers/1', title: 'Eng' }), 'atsApiClient correctly deflects Workday to browser fleet');

  // ── TEST 5: High-Speed Bulk Execution Simulation ──
  console.log('\nTest Suite 5: High-Speed Bulk Engine (10 Parallel Jobs)');
  const bulkTargets: JobTarget[] = [
    { url: 'https://job-boards.greenhouse.io/co1/jobs/1', title: 'Eng 1', atsType: 'greenhouse', boardToken: 'co1', externalId: '1' },
    { url: 'https://job-boards.greenhouse.io/co2/jobs/2', title: 'Eng 2', atsType: 'greenhouse', boardToken: 'co2', externalId: '2' },
    { url: 'https://jobs.lever.co/co3/3', title: 'Eng 3', atsType: 'lever', boardToken: 'co3', externalId: '3' },
    { url: 'https://jobs.lever.co/co4/4', title: 'Eng 4', atsType: 'lever', boardToken: 'co4', externalId: '4' },
    { url: 'https://jobs.ashbyhq.com/co5/5', title: 'Eng 5', atsType: 'ashby', boardToken: 'co5', externalId: '5' },
    { url: 'https://jobs.smartrecruiters.com/co6/6', title: 'Eng 6', atsType: 'smartrecruiters', boardToken: 'co6', externalId: '6' },
    { url: 'https://apply.workable.com/co7/7', title: 'Eng 7', atsType: 'workable', boardToken: 'co7', externalId: '7' },
    { url: 'https://co8.recruitee.com/o/8', title: 'Eng 8', atsType: 'recruitee', boardToken: 'co8', externalId: '8' },
    { url: 'https://job-boards.greenhouse.io/co9/jobs/9', title: 'Eng 9', atsType: 'greenhouse', boardToken: 'co9', externalId: '9' },
    { url: 'https://jobs.lever.co/co10/10', title: 'Eng 10', atsType: 'lever', boardToken: 'co10', externalId: '10' },
  ];

  const bulkReport = await bulkApiEngine.applyBatch('test-user-id', bulkTargets, 5, { dryRun: true });
  assert(bulkReport.total === 10, 'Bulk processed all 10 target jobs');
  assert(bulkReport.succeeded === 10, 'All 10 applications succeeded in dry run mode');
  assert(bulkReport.failed === 0, 'Zero application failures');
  assert(bulkReport.durationMs < 2000, `Bulk finished in ${bulkReport.durationMs}ms (average < 200ms per job)`);

  console.log('\n======================================================');
  console.log(`VERIFICATION SUMMARY: ${passed} PASSED, ${failed} FAILED`);
  console.log('======================================================\n');

  if (failed > 0) {
    process.exit(1);
  }
}

void runLiveVerification();

