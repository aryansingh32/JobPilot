import { getPgPool } from '../packages/shared/db/index.js';

async function main() {
  const pool = getPgPool();
  
  const cols = await pool.query("SELECT column_name FROM information_schema.columns WHERE table_name = 'credit_ledger';");
  console.log('credit_ledger columns:', cols.rows.map((r: { column_name: string }) => r.column_name).join(', '));

  const { rows: ledger } = await pool.query(`
    SELECT * FROM credit_ledger LIMIT 5;
  `);
  console.log('\n=== Sample Ledger Rows ===', ledger);

  const { rows: apps } = await pool.query(`
    SELECT id, user_id, title, company, status, reference, created_at
    FROM applications
    ORDER BY created_at DESC
    LIMIT 5
  `);
  console.log('\n=== Recent Applications ===', apps);

  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
