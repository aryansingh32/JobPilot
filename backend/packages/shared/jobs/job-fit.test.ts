import { describe, expect, it } from 'vitest';
import { analyzeFit } from './job-fit.js';

const profile = {
  skills: ['TypeScript', 'React'],
  experience: [{ company: 'A', title: 'Frontend Engineer', start: '2022-01', highlights: ['Built dashboards in React and Node.js serving 10k users', 'Cut load time 40% with caching'] }],
  work: { yearsOfExperience: 4 },
};

describe('analyzeFit', () => {
  it('separates have / missing and finds skills worth listing', () => {
    const fit = analyzeFit(profile, { title: 'Full Stack Engineer', description: 'You will use TypeScript, React, Node.js and Docker. Nice to have: Kubernetes and GraphQL. '.padEnd(260, ' ') + 'Nice to have: Kubernetes.', experience_min: 3, experience_max: 6 });
    expect(fit.required.have).toEqual(expect.arrayContaining(['TypeScript', 'React']));
    expect(fit.required.missing).toContain('Docker');
    expect(fit.listThese.map((s) => s.toLowerCase())).toContain('node.js');
    expect(fit.experience.status).toBe('meets');
  });
  it('flags too little experience', () => {
    const fit = analyzeFit(profile, { title: 'Staff Engineer', description: 'TypeScript React', experience_min: 8 });
    expect(fit.experience.status).toBe('below');
    expect(fit.advice.join(' ')).toMatch(/Asks for 8\+ years/);
  });
  it('calls an empty overlap unlikely', () => {
    const fit = analyzeFit({ skills: ['Excel'] }, { title: 'Rust Engineer', description: 'Rust, Kubernetes, Terraform, AWS, Go', experience_min: 5 });
    expect(fit.verdict).toBe('unlikely');
  });
});
