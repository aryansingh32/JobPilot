import { profileService } from '../packages/shared/profile/index.js';
import { profileGaps } from '../packages/shared/profile/gaps.js';
import { getPgPool } from '../packages/shared/db/index.js';

async function main() {
  const userId = 'df542b61-574e-4123-ad02-089ca96b352e';
  
  await profileService.patch(userId, {
    personal: {
      fullName: 'Jordan Rivera',
      firstName: 'Jordan',
      lastName: 'Rivera',
      email: 'jordan.rivera.dev@gmail.com',
      phone: '+1-555-0199',
      city: 'San Francisco',
      state: 'CA',
      country: 'United States',
      address: '500 Howard Street',
      postalCode: '94105',
      linkedin: 'https://linkedin.com/in/jordanrivera-dev',
      github: 'https://github.com/jordanrivera-dev',
      summary: 'Experienced Senior Full-Stack and Backend Engineer with 5+ years building distributed cloud applications.',
    },
    work: {
      currentTitle: 'Senior Software Engineer',
      currentEmployer: 'Apex Systems',
      experienceLevel: '5+ years',
      noticePeriod: 'Immediately',
      expectedSalary: '$140,000 / year',
      yearsOfExperience: 5,
    },
    authorization: {
      statement: 'Authorized to work in the US without sponsorship',
      needsSponsorship: false,
      countries: ['US', 'United States'],
    },
    education: [
      {
        school: 'University of California, Berkeley',
        degree: 'Bachelor of Science',
        field: 'Computer Science',
        start: '2016',
        end: '2020',
        current: false,
      },
    ],
    experience: [
      {
        company: 'Apex Systems',
        title: 'Senior Software Engineer',
        location: 'San Francisco, CA',
        start: '2021',
        current: true,
        highlights: [
          'Engineered real-time distributed microservices with Node.js and TypeScript',
          'Designed high-throughput PostgreSQL databases and caching systems',
        ],
      },
    ],
    skills: ['TypeScript', 'Node.js', 'PostgreSQL', 'Redis', 'Docker', 'AWS', 'React'],
  }, 'live-test-setup');

  const profile = await profileService.get(userId);
  console.log('Updated Profile Completeness:', profile.completeness);
  const gaps = profileGaps(profile.data, { country: 'United States' });
  console.log('Remaining Blocking Gaps:', gaps.filter(g => g.blocking));

  // Check user credit balance
  const pool = getPgPool();
  const { rows: ledger } = await pool.query(
    'SELECT SUM(amount) as balance FROM credit_ledger WHERE user_id = $1',
    [userId]
  ).catch(async () => {
    return await pool.query('SELECT SUM(delta) as balance FROM credit_ledger WHERE user_id = $1', [userId]);
  });
  console.log('User Credit Balance:', ledger[0]?.balance);

  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

