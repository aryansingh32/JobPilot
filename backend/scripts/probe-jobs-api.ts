import { atsApiClient } from '../packages/shared/applications/api-engine/client.js';
import { getPgPool } from '../packages/shared/db/index.js';
import type { JobTarget } from '../packages/shared/applications/api-engine/types.js';

async function main() {
  const pool = getPgPool();
  const { rows: jobs } = await pool.query(`
    SELECT j.id, j.title, c.name as company, j.url, b.ats_type, b.board_token, j.external_id
    FROM jobs j
    JOIN companies c ON c.id = j.company_id
    JOIN job_boards b ON b.id = j.board_id
    WHERE b.ats_type IN ('greenhouse', 'lever', 'ashby')
    LIMIT 10
  `);

  console.log(`Checking ${jobs.length} candidate jobs for live API availability...`);
  
  for (const job of jobs) {
    const target: JobTarget = {
      jobId: job.id,
      url: job.url,
      title: job.title,
      company: job.company,
      atsType: job.ats_type,
      boardToken: job.board_token,
      externalId: job.external_id,
    };

    const canApply = atsApiClient.canApplyViaApi(target);
    const provider = atsApiClient.findProvider(target);
    console.log(`\nJob: ${job.company} - "${job.title}" (${job.ats_type})`);
    console.log(`  URL: ${job.url}`);
    console.log(`  Provider: ${provider?.name}, canApply: ${canApply}`);

    if (provider) {
      try {
        const schema = await provider.fetchSchema(target);
        console.log(`  -> Successfully fetched live schema: ${schema.length} questions`);
        if (schema.length > 0) {
          console.log(`     Sample questions:`, schema.slice(0, 3).map(q => q.label));
        }
      } catch (err) {
        console.log(`  -> Schema fetch failed: ${(err as Error).message}`);
      }
    }
  }

  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

