import { describe, it, expect } from 'vitest';
import { analyzeProfile, buildAnswerBank, missingRequired } from './resume-analysis.js';
import { acceptable } from './answer-bank.js';
import type { ProfileData } from './index.js';

const strong: ProfileData = {
  personal: { fullName: 'A B', email: 'a@b.co', phone: '9876543210', city: 'Pune', country: 'IN', linkedin: 'https://linkedin.com/in/ab', summary: 'Backend engineer with five years building payment APIs in Node.js and Postgres, focused on reliability and clear ownership of services from design to on-call.' },
  work: { yearsOfExperience: 5, noticePeriod: '30 days', expectedSalary: '30 LPA', currentTitle: 'Backend Engineer', currentEmployer: 'Acme' },
  experience: [{ company: 'Acme', title: 'Backend Engineer', start: '2021-01', current: true, highlights: ['Reduced p95 latency from 800ms to 200ms by caching hot queries', 'Built a billing service handling 20k requests per minute', 'Led migration of 12 services to Kubernetes'] }],
  education: [{ school: 'IIT', degree: 'B.Tech', field: 'CS', end: '2020-06' }],
  skills: ['Node.js', 'TypeScript', 'PostgreSQL', 'Redis', 'Docker', 'AWS', 'Kafka', 'SQL', 'Git'],
  preferences: { roles: ['Backend Engineer'], workplace: ['Remote'] },
  authorization: { needsSponsorship: false },
  certifications: ['AWS SA'],
};

describe('resume analysis', () => {
  it('scores a complete résumé high and an empty one low', () => {
    expect(analyzeProfile(strong).score).toBeGreaterThanOrEqual(80);
    const weak = analyzeProfile({ personal: { fullName: 'A' } });
    expect(weak.score).toBeLessThan(30);
    expect(weak.findings[0].severity).toBe('high');
  });
  it('asks for numbers when bullets have none, and says how much of a form it already answers', () => {
    const p: ProfileData = { ...strong, experience: [{ company: 'Acme', title: 'Dev', start: '2021', highlights: ['Worked on APIs', 'Helped the team', 'Fixed bugs'] }] };
    expect(analyzeProfile(p).findings.some((f) => f.id === 'quantify')).toBe(true);
    expect(analyzeProfile(strong).coverage.percent).toBeGreaterThan(60);
    expect(analyzeProfile({}).coverage.percent).toBeLessThan(10);
  });
  it('lists what onboarding cannot skip', () => {
    expect(missingRequired({}).length).toBeGreaterThanOrEqual(7);
    expect(missingRequired(strong).map((m) => m.key)).toEqual([]);
  });
});

describe('answer bank', () => {
  it('is built from the résumé only, in the first person', () => {
    const b = buildAnswerBank(strong);
    expect(b.aboutYou).toContain('payment APIs');
    expect(b.achievement).toMatch(/latency|requests|Kubernetes/);
    expect(b.careerGoal).toContain('Backend Engineer');
    expect(b.strengths).toContain('Node.js');
  });
  it('rejects a polished answer that invents a number', () => {
    const facts = JSON.stringify({ years: 5, achievement: 'cut latency 60%' });
    expect(acceptable('I have 5 years of experience and cut latency by 60% across services.', facts)).toBe(true);
    expect(acceptable('I have 9 years of experience and cut latency by 60% across services.', facts)).toBe(false);
    expect(acceptable('Hi [name], I am a great fit for this role and bring years of experience.', facts)).toBe(false);
  });
});
