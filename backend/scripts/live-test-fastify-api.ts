import Fastify, { FastifyRequest, FastifyReply } from 'fastify';
import { signSession } from '../packages/shared/auth/index.js';
import { registerMeRoutes } from '../packages/api-service/me-routes.js';
import { getPgPool } from '../packages/shared/db/index.js';

const API_KEY = process.env.API_KEY || '3b814406187a4a7d3feffdd35838120c0f29ac27da2a30e0fe74be537071064c';

async function authMiddleware(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const key = req.headers['x-api-key'];
  if (key !== API_KEY) {
    reply.status(401).send({ error: 'Unauthorized' });
  }
}

async function testFastifyApiEndpoint() {
  console.log('========================================================================');
  console.log('🌐 JOBPILOT REST API LAYER LIVE HTTP ENDPOINT TEST (/me/applications)');
  console.log('========================================================================\n');

  const userId = 'df542b61-574e-4123-ad02-089ca96b352e';
  const pool = getPgPool();

  // 1. Generate an authentic Bearer JWT Session Token
  const token = await signSession({ sub: userId, email: 'jordan.rivera.dev@gmail.com' });
  console.log('  🔑 Issued Live Signed Session JWT for Jordan Rivera');

  // 2. Select a target job from the DB (e.g. Ashby job at Endra)
  const { rows: jobs } = await pool.query(`
    SELECT j.id, j.title, c.name as company, j.url, b.ats_type
    FROM jobs j
    JOIN companies c ON c.id = j.company_id
    JOIN job_boards b ON b.id = j.board_id
    WHERE b.ats_type = 'ashby' AND j.external_id = '96b8c861-e4bb-43f8-95c2-c199de66e308'
    LIMIT 1
  `);
  const targetJob = jobs[0];
  console.log(`  🎯 Target Job: ${targetJob.company} - "${targetJob.title}" (${targetJob.ats_type})`);
  console.log(`     Job ID: ${targetJob.id}`);

  // 3. Clean any existing applications for this target to test fresh
  await pool.query('DELETE FROM applications WHERE user_id = $1 AND job_id = $2', [userId, targetJob.id]);

  // 4. Initialize Fastify app with me-routes
  const app = Fastify({ logger: false });
  registerMeRoutes(app, authMiddleware);
  await app.ready();

  // 5. Fire HTTP POST request to /me/applications with Bearer token and x-api-key
  console.log('\n  📡 Sending POST /me/applications request with Bearer Auth & API Key...');
  const t0 = performance.now();
  const response = await app.inject({
    method: 'POST',
    url: '/me/applications',
    headers: {
      'x-api-key': API_KEY,
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
    },
    payload: {
      jobId: targetJob.id,
      confirmDuplicate: true,
      dryRun: true,
    },
  });
  const t1 = performance.now();
  const latencyMs = Math.round(t1 - t0);

  console.log(`\n  HTTP Status Code: ${response.statusCode} (Expected: 201 Created)`);
  console.log(`  Total REST API Roundtrip Time: ${latencyMs} ms`);

  const responseBody = JSON.parse(response.body);
  console.log('\n  📦 Server Response Payload:');
  console.log(JSON.stringify(responseBody, null, 2));

  // 6. Assertions
  if (response.statusCode !== 201) {
    throw new Error(`Expected HTTP 201 but received ${response.statusCode}: ${response.body}`);
  }

  if (responseBody.application?.status !== 'submitted') {
    throw new Error(`Expected application status to be 'submitted', got '${responseBody.application?.status}'`);
  }

  if (!responseBody.apiResult?.success) {
    throw new Error('Expected apiResult.success to be true');
  }

  console.log('\n========================================================================');
  console.log('🎉 FASTIFY REST API ENDPOINT LIVE TEST PASSED CLEANLY (HTTP 201)!');
  console.log('========================================================================\n');

  await app.close();
  process.exit(0);
}

testFastifyApiEndpoint().catch((err) => {
  console.error('REST API Test Failed:', err);
  process.exit(1);
});
