import { describe, expect, it } from 'vitest';
import { closingDate, hiringOrg, parseIndianDate, portalKind, postToJob, roleFromTitle, vacancyCount, officialLink, isApplicationNotice, type SarkariPost } from './sarkari.js';

const post = (over: { html: string; title: string; date?: string }): SarkariPost => ({
  id: 1,
  date: over.date ?? '2026-10-20T09:00:00',
  link: 'https://sarkarinaukri.com/x/',
  title: { rendered: over.title },
  content: { rendered: over.html },
  categories: [8, 43],
});

describe('sarkari parsing', () => {
  it('reads the dates government notices use', () => {
    expect(parseIndianDate('31.10.2025')?.toISOString()).toBe('2025-10-31T18:29:59.000Z');
    expect(parseIndianDate('20th October 2025')?.getUTCDate()).toBe(20);
    expect(parseIndianDate('October 31, 2025')?.getUTCMonth()).toBe(9);
    expect(parseIndianDate('32.13.2025')).toBeNull();
  });
  it('finds the closing date', () => {
    expect(closingDate('Last Date for Submission of Online Application: 10.11.2025')?.getUTCMonth()).toBe(10);
    expect(closingDate('Deadline November 16, 2025')?.getUTCDate()).toBe(16);
    expect(closingDate('no date here')).toBeNull();
  });
  it('names the employer, role and vacancies', () => {
    expect(hiringOrg('BEL Announces Recruitment for 340 Probationary Engineer Positions')).toBe('BEL');
    expect(hiringOrg('Bank of Baroda Announces Recruitment 2025 for 58 Officer Positions')).toBe('Bank of Baroda');
    expect(roleFromTitle('BEL Announces Recruitment for 340 Probationary Engineer Positions')).toBe('Probationary Engineer');
    expect(vacancyCount('BEL Announces Recruitment for 340 Probationary Engineer Positions', '')).toBe(340);
  });
  it('picks the official site, not the news site or a PDF', () => {
    const html = '<a href="https://sarkarinaukri.com/quiz/">q</a><a href="https://x.gov.in/n.pdf">pdf</a><a href="http://www.bel-india.in">site</a>';
    expect(officialLink(html)).toBe('http://www.bel-india.in');
  });
  it('maps portals to departments', () => {
    expect(portalKind('https://ssc.gov.in/apply')).toBe('ssc');
    expect(portalKind('https://bpsc.bih.nic.in')).toBe('psc');
    expect(portalKind('https://www.bel-india.in')).toBe('psu');
  });
  it('keeps open notices and drops closed ones', () => {
    const now = new Date('2026-10-24T00:00:00Z');
    const open = post({ title: 'ABC Announces Recruitment for 5 Clerks', html: '<p>Last date to apply: 15 November 2026</p><a href="https://abc.gov.in">x</a>' });
    const closed = post({ title: 'ABC Announces Recruitment for 5 Clerks', html: '<p>Last date to apply: 15 September 2026</p>' });
    expect(postToJob(open, now)?.closesAt?.getUTCMonth()).toBe(10);
    expect(postToJob(open, now)?.company).toBe('ABC');
    expect(postToJob(closed, now)).toBeNull();
  });
  it('undated notices expire 45 days after publishing', () => {
    const p = post({ title: 'ABC Announces Recruitment', html: '<p>Apply soon</p>', date: '2026-10-20T09:00:00' });
    expect(postToJob(p, new Date('2026-11-01T00:00:00Z'))).not.toBeNull();
    expect(postToJob(p, new Date('2026-12-30T00:00:00Z'))).toBeNull();
  });
  it('keeps recruitment notices and drops results, admit cards and answer keys', () => {
    expect(isApplicationNotice('UPESSC Recruitment 2026 Apply Online for 500 Posts')).toBe(true);
    expect(isApplicationNotice('SSC CGL Admit Card 2026')).toBe(false);
    expect(isApplicationNotice('IBPS PO Result 2026 Out')).toBe(false);
    expect(isApplicationNotice('NEET Answer Key 2026')).toBe(false);
  });
  it('never takes a video, link shortener or sister aggregator page as the apply link', () => {
    const html = '<a href="https://youtu.be/abc">Watch</a> <a href="https://sarkariresult.com/x">More</a> <a href="https://upsssc.gov.in/apply">Apply Online</a>';
    expect(officialLink(html, 'rojgarresult\\.com')).toBe('https://upsssc.gov.in/apply');
  });
});
