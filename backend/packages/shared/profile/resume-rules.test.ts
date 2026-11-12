import { describe, expect, it } from 'vitest';
import { ruleExtract } from './resume-parser.js';

const RESUME = `RAHUL SHARMA
Lucknow, Uttar Pradesh | +91 98765 43210 | rahul.sharma@gmail.com

PROFESSIONAL SUMMARY
Backend engineer with 3 years of experience building scalable APIs for fintech products.

EXPERIENCE
Software Engineer — Infosys Ltd, Pune                    Jul 2022 – Present
• Built REST APIs in Node.js and PostgreSQL serving 2M requests/day
Junior Developer, TCS, Lucknow                           Jun 2021 - Jun 2022
• Developed internal tools using React and Python

EDUCATION
B.Tech in Computer Science, Dr. A.P.J. Abdul Kalam Technical University, 2017 – 2021   CGPA: 8.1/10

SKILLS
Languages: JavaScript, TypeScript, Python, SQL
Tools: Docker, Git, AWS, Redis

CERTIFICATIONS
AWS Certified Cloud Practitioner (2023)
`;

describe('ruleExtract on an Indian résumé', () => {
  const r = ruleExtract(RESUME);
  it('reads city, state, country and summary from the header', () => {
    expect(r.personal).toMatchObject({ city: 'Lucknow', state: 'Uttar Pradesh', country: 'IN' });
    expect(r.personal?.summary).toMatch(/Backend engineer/);
  });
  it('splits "Title, Company, City" and "Title — Company, City"', () => {
    expect(r.experience?.map((e) => [e.title, e.company, e.location])).toEqual([
      ['Software Engineer', 'Infosys Ltd', 'Pune'],
      ['Junior Developer', 'TCS', 'Lucknow'],
    ]);
  });
  it('keeps the grade, certifications and listed skills', () => {
    expect(r.education?.[0].grade).toBe('8.1/10');
    expect(r.certifications).toEqual(['AWS Certified Cloud Practitioner (2023)']);
    expect(r.skills).toEqual(expect.arrayContaining(['JavaScript', 'Docker', 'Redis']));
  });
});
