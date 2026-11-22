import { profileService } from '../packages/shared/profile/index.js';
import { profileGaps } from '../packages/shared/profile/gaps.js';

async function main() {
  const userId = 'df542b61-574e-4123-ad02-089ca96b352e';
  const profile = await profileService.get(userId);
  console.log('Profile data:', JSON.stringify(profile.data, null, 2));
  const gaps = profileGaps(profile.data, { country: 'United States' });
  console.log('Profile gaps:', gaps);
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

