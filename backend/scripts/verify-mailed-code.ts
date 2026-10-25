import { getPgPool } from '../packages/shared/db/index.js';
import { waitForMail, waitForMailedCode } from '../packages/execution-service/executor.js';
import { randomUUID } from 'crypto';
import { applicationEmail } from '../packages/shared/inbox/index.js';

const pool = getPgPool();
const userId = `mailtest-${randomUUID()}`;
let failed = 0;
const check = (ok: boolean, m: string) => { console.log(ok ? '  ✓' : '  ✗', m); if (!ok) failed++; };
const ctx = { userId } as any;
const insert = (code: string, at: Date) => pool.query(
  `INSERT INTO emails (user_id, to_address, from_address, subject, extracted_code, received_at) VALUES ($1,'me@inbox.test','noreply@nic.in','Your OTP',$2,$3)`, [userId, code, at]);

await insert('111111', new Date(Date.now() - 10 * 60_000)); // an old code must be ignored
const none = await waitForMailedCode(ctx, Date.now() - 3000, 3000);
check(none === null, 'an old code is ignored and, with nothing new, returns null (so the user is asked)');
const pending = waitForMailedCode(ctx, Date.now() - 3000, 15_000);
setTimeout(() => void insert('482913', new Date()), 4000);
check((await pending) === '482913', 'a code that arrives mid-wait is picked up from the inbox');
// A verification LINK waited on quietly, with no ask on screen.
const ctx2 = { userId, jobId: 'x', page: { url: () => 'https://acme.wd5.myworkdayjobs.com/x' } } as any;
const linkWait = waitForMail(ctx2, 'link', Date.now() - 1000, 15_000);
setTimeout(() => void pool.query(
  `INSERT INTO emails (user_id, to_address, from_address, subject, extracted_link, received_at) VALUES ($1,'me@x.test','noreply@myworkday.com','Verify',$2,now())`,
  [userId, 'https://acme.wd5.myworkdayjobs.com/verify?t=abc']), 3000);
check((await linkWait) === 'https://acme.wd5.myworkdayjobs.com/verify?t=abc', 'a verification link that arrives mid-wait is picked up');
// The personal address IS the connected Gmail: read it through Gmail without the mode being switched.
await pool.query(`INSERT INTO mail_connections (user_id, provider, address, refresh_token, status) VALUES ($1,'gmail','Me@Gmail.com','x','active')`, [userId]);
const viaGmail = await applicationEmail(userId, { email: 'me@gmail.com' }, 'personal');
check(viaGmail.via === 'gmail', 'personal email equal to the connected Gmail is read via Gmail');
const other = await applicationEmail(userId, { email: 'someone.else@gmail.com' }, 'personal');
check(other.via === 'personal', 'a different personal address is not read');
await pool.query('DELETE FROM mail_connections WHERE user_id = $1', [userId]);
await pool.query('DELETE FROM emails WHERE user_id = $1', [userId]);
process.exit(failed ? 1 : 0);
