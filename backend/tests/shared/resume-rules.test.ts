import { describe, it, expect } from 'vitest';
import { ruleExtract } from '../../packages/shared/profile/resume-parser.js';

const RESUME = `Jordan Rivera
jordan@example.com · +1 415 555 0142 · San Francisco, CA, USA · linkedin.com/in/jordan-rivera · github.com/jrivera-
e2e
Summary
Backend software engineer with 3 years of experience building APIs.
Experience
Software Engineer, Northwind Analytics — San Francisco, CA — Jun 2023 – Present
Built Node.js/TypeScript services on AWS.
Cut API latency 40% with Redis caching.
Software Engineer Intern, Contoso Labs — Remote — Jun 2022 – Aug 2022
Built Python ETL jobs.
Education
B.S. Computer Science, University of California, Davis — 2023
Skills
TypeScript, Node.js, PostgreSQL`;

describe('ruleExtract (no AI)', () => {
  const p = ruleExtract(RESUME);

  it('reads the header: name, links (rejoining a wrapped one), place', () => {
    expect(p.personal).toMatchObject({
      fullName: 'Jordan Rivera', firstName: 'Jordan', lastName: 'Rivera',
      github: 'https://github.com/jrivera-e2e', city: 'San Francisco', state: 'CA', country: 'US',
    });
  });

  it('maps "N years of experience" to the onboarding band', () => {
    expect(p.work?.experienceLevel).toBe('2–5 years');
  });

  it('reads work history from the date lines', () => {
    expect(p.experience).toHaveLength(2);
    expect(p.experience?.[0]).toMatchObject({
      title: 'Software Engineer', company: 'Northwind Analytics', location: 'San Francisco, CA', start: '2023-06', current: true,
    });
    expect(p.experience?.[0].highlights).toEqual(['Built Node.js/TypeScript services on AWS.', 'Cut API latency 40% with Redis caching.']);
    expect(p.experience?.[1]).toMatchObject({ title: 'Software Engineer Intern', company: 'Contoso Labs', location: 'Remote', start: '2022-06', end: '2022-08' });
    expect(p.work).toMatchObject({ currentEmployer: 'Northwind Analytics', currentTitle: 'Software Engineer' });
  });

  it('reads education', () => {
    expect(p.education?.[0]).toMatchObject({ degree: 'B.S.', field: 'Computer Science', end: '2023' });
    expect(p.education?.[0].school).toBe('University of California, Davis');
  });

  it('handles "Company | Title" with dates on their own line', () => {
    const q = ruleExtract(`Asha Verma\nExperience\nInfosys | Senior Developer | Bengaluru, India\n03/2019 - 01/2022\nLed a team of 4.\nEducation\nB.Tech in Electronics, IIT Delhi, 2014 - 2018`);
    expect(q.experience?.[0]).toMatchObject({ company: 'Infosys', title: 'Senior Developer', location: 'Bengaluru, India', start: '2019-03', end: '2022-01' });
    expect(q.education?.[0]).toMatchObject({ school: 'IIT Delhi', degree: 'B.Tech', field: 'Electronics', start: '2014', end: '2018' });
  });
});

import { experienceFromText } from '../../packages/shared/jobs/normalize.js';

describe('experienceFromText', () => {
  it.each([
    ['Looking for 2-5 years of experience in Java', 2, 5],
    ['Experience: 3+ yrs in sales', 3, null],
    ['Minimum 4 years experience required', 4, null],
    ['We are a company with a legacy of over 85 years', null, null],
    ['Freshers welcome!', 0, 1],
    ['6 years of relevant experience with React', 6, null],
  ])('%s', (text, min, max) => {
    expect(experienceFromText(text)).toEqual({ min, max });
  });
});

import { detectCountry } from '../../packages/shared/jobs/normalize.js';
describe('detectCountry (India)', () => {
  it.each([
    ['Pune, MH, IN', 'IN'], ['Hinjewadi, Pune', 'IN'], ['Navi Mumbai', 'IN'], ['Gurugram, Haryana', 'IN'],
    ['Bengaluru, IND-29, IN, 560035', 'IN'], ['Indianapolis, IN', 'US'], ['Karnataka', 'IN'],
  ])('%s → %s', (loc, code) => expect(detectCountry(loc)).toBe(code));
});
