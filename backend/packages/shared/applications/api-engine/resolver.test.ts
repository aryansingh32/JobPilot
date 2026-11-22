import { describe, expect, it } from 'vitest';
import { QuestionResolver } from './resolver.js';
import type { CandidateProfile, QuestionDefinition } from './types.js';

const mockCandidate: CandidateProfile = {
  personal: {
    fullName: 'Jane Doe',
    firstName: 'Jane',
    lastName: 'Doe',
    email: 'jane.doe@example.com',
    phone: '+1-555-0199',
    city: 'San Francisco',
    state: 'CA',
    country: 'United States',
    address: '100 Market St',
    postalCode: '94105',
    linkedin: 'https://linkedin.com/in/janedoe',
    github: 'https://github.com/janedoe',
    website: 'https://janedoe.dev',
    summary: 'Senior Backend Engineer with 6 years experience in distributed systems.',
  },
  work: {
    currentTitle: 'Senior Software Engineer',
    currentEmployer: 'TechCorp',
    experienceLevel: 'Senior',
    noticePeriod: '2 weeks',
    expectedSalary: '$160,000',
    yearsOfExperience: 6,
  },
  authorization: {
    statement: 'Authorized to work in US without sponsorship',
    needsSponsorship: false,
    authorizedCountries: ['US', 'United States'],
  },
  answersBank: {
    'relocation': 'Yes, open to relocation for the right role.',
    'microservices': 'Over 5 years building scalable microservices in Node and Go.',
  },
  eeo: {
    gender: 'Female',
    race: 'Asian',
    veteranStatus: 'I am not a protected veteran',
    disabilityStatus: "No, I don't have a disability",
  },
  resume: {
    buffer: Buffer.from('Mock PDF Content'),
    fileName: 'Jane_Doe_Resume.pdf',
    mimeType: 'application/pdf',
  },
};

describe('QuestionResolver', () => {
  it('maps personal identity fields correctly', () => {
    const q1: QuestionDefinition = { id: 'q1', label: 'First Name', required: true, fields: [{ name: 'first_name', type: 'input_text' }] };
    const q2: QuestionDefinition = { id: 'q2', label: 'Last Name', required: true, fields: [{ name: 'last_name', type: 'input_text' }] };
    const q3: QuestionDefinition = { id: 'q3', label: 'Email Address', required: true, fields: [{ name: 'email', type: 'input_text' }] };
    const q4: QuestionDefinition = { id: 'q4', label: 'Mobile Phone', required: false, fields: [{ name: 'phone', type: 'input_text' }] };

    const answers = QuestionResolver.resolveAll([q1, q2, q3, q4], mockCandidate);
    expect(answers.first_name).toBe('Jane');
    expect(answers.last_name).toBe('Doe');
    expect(answers.email).toBe('jane.doe@example.com');
    expect(answers.phone).toBe('+1-555-0199');
  });

  it('resolves work authorization and sponsorship with option matching', () => {
    const qAuth: QuestionDefinition = {
      id: 'q_auth',
      label: 'Are you legally authorized to work in the United States?',
      required: true,
      fields: [
        {
          name: 'work_auth',
          type: 'multi_value_single_select',
          values: [
            { label: 'Yes', value: 101 },
            { label: 'No', value: 102 },
          ],
        },
      ],
    };

    const qSpons: QuestionDefinition = {
      id: 'q_spons',
      label: 'Will you now or in the future require visa sponsorship?',
      required: true,
      fields: [
        {
          name: 'sponsorship',
          type: 'multi_value_single_select',
          values: [
            { label: 'Yes, I will require sponsorship', value: 201 },
            { label: 'No, I will not require sponsorship', value: 202 },
          ],
        },
      ],
    };

    const answers = QuestionResolver.resolveAll([qAuth, qSpons], mockCandidate);
    expect(answers.work_auth).toBe(101);
    expect(answers.sponsorship).toBe(202);
  });

  it('resolves notice period, experience, and salary', () => {
    const qNotice: QuestionDefinition = {
      id: 'q_notice',
      label: 'What is your notice period / availability?',
      required: true,
      fields: [
        {
          name: 'notice',
          type: 'multi_value_single_select',
          values: [
            { label: 'Immediate', value: 'imm' },
            { label: '2 weeks', value: '2w' },
            { label: '1 month', value: '1m' },
          ],
        },
      ],
    };

    const qExp: QuestionDefinition = {
      id: 'q_exp',
      label: 'Years of Experience in Software Development',
      required: true,
      fields: [{ name: 'yoe', type: 'input_text' }],
    };

    const answers = QuestionResolver.resolveAll([qNotice, qExp], mockCandidate);
    expect(answers.notice).toBe('2w');
    expect(answers.yoe).toBe(6);
  });

  it('chooses the provider explicit decline option for voluntary EEO questions', () => {
    const qGender: QuestionDefinition = {
      id: 'q_gender',
      label: 'Gender',
      required: false,
      fields: [
        {
          name: 'gender',
          type: 'multi_value_single_select',
          values: [
            { label: 'Male', value: 1 },
            { label: 'Female', value: 2 },
            { label: 'Decline To Self Identify', value: 3 },
          ],
        },
      ],
    };

    const qRace: QuestionDefinition = {
      id: 'q_race',
      label: 'Race or Ethnicity',
      required: false,
      fields: [
        {
          name: 'race',
          type: 'multi_value_single_select',
          values: [
            { label: 'Asian', value: 10 },
            { label: 'White', value: 20 },
            { label: 'Decline To Self Identify', value: 99 },
          ],
        },
      ],
    };

    const answers = QuestionResolver.resolveAll([qGender, qRace], mockCandidate);
    expect(answers.gender).toBe(3);
    expect(answers.race).toBe(99);
  });

  it('does not guess legal attestations, background checks, or required demographics', () => {
    const questions: QuestionDefinition[] = [
      { id: 'criminal', label: 'Have you ever been convicted of a crime?', required: true, fields: [{ name: 'criminal', type: 'boolean', values: [{ label: 'Yes', value: 'yes' }, { label: 'No', value: 'no' }] }] },
      { id: 'attest', label: 'I certify this information is true and complete', required: true, fields: [{ name: 'attest', type: 'boolean', values: [{ label: 'I agree', value: 'agree' }] }] },
      { id: 'gender', label: 'Gender', required: true, fields: [{ name: 'gender', type: 'select', values: [{ label: 'Decline to disclose', value: 'decline' }] }] },
    ];
    const result = QuestionResolver.resolveAllDetailed(questions, mockCandidate);
    expect(result.requiresUserAction).toBe(true);
    expect(result.unresolvedRequired.map((q) => q.id)).toEqual(['criminal', 'attest', 'gender']);
    expect(result.answers).toEqual({});
  });

  it('requires user action for required questions with missing field metadata', () => {
    const result = QuestionResolver.resolveAllDetailed([
      { id: 'opaque', label: 'Required question', required: true, fields: [] },
    ], mockCandidate);
    expect(result.requiresUserAction).toBe(true);
    expect(result.unresolvedRequired[0].id).toBe('opaque');
  });

  it('resolves semantic queries from answersBank', () => {
    const qCustom: QuestionDefinition = {
      id: 'q_reloc',
      label: 'Please state your relocation preferences',
      required: true,
      fields: [{ name: 'relocation_pref', type: 'textarea' }],
    };

    const answers = QuestionResolver.resolveAll([qCustom], mockCandidate);
    expect(answers.relocation_pref).toBe('Yes, open to relocation for the right role.');
  });

  it('does NOT guess answers for unmapped mandatory questions and flags requiresUserAction', () => {
    const qUnknownRequired: QuestionDefinition = {
      id: 'q_unknown',
      label: 'Have you ever had any non-compete restriction violations?',
      required: true,
      fields: [
        {
          name: 'restrictions',
          type: 'multi_value_single_select',
          values: [
            { label: 'Yes', value: 'yes_res' },
            { label: 'No', value: 'no_res' },
          ],
        },
      ],
    };

    const detailed = QuestionResolver.resolveAllDetailed([qUnknownRequired], mockCandidate);
    expect(detailed.requiresUserAction).toBe(true);
    expect(detailed.unresolvedRequired.length).toBe(1);
    expect(detailed.unresolvedRequired[0].id).toBe('q_unknown');
    expect(detailed.answers.restrictions).toBeUndefined();
  });
});

