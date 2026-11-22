/** Read-only monthly report. Usage: node --import tsx scripts/cost-report.ts YYYY-MM [operating-inputs.json] */
import { readFile } from 'node:fs/promises';
import { getPgPool } from '../packages/shared/db/index.js';
import { calculateEconomics, type OperatingInputs } from '../packages/shared/finance/economics.js';
import { SETTINGS } from '../packages/shared/config/settings.js';
const month = process.argv[2];
if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month ?? '')) throw new Error('Supply month as YYYY-MM');
const inputs: OperatingInputs = process.argv[3] ? JSON.parse(await readFile(process.argv[3], 'utf8')) : { infrastructureUsd:null,proxiesUsd:null,paymentFeesUsd:null,refundsUsd:null,indirectTaxesUsd:null,supportAndOtherUsd:null,inrPerUsd:null };
const pool = getPgPool();
try {
  const start = `${month}-01T00:00:00Z`;
  const [payments, llm, captcha, applications, settings] = await Promise.all([
    pool.query(`SELECT currency, COUNT(*)::int AS payments, SUM(amount)::numeric / 100 AS receipts, SUM(credits)::int AS credits_sold FROM payments WHERE status='paid' AND paid_at >= $1::timestamptz AND paid_at < $1::timestamptz + interval '1 month' GROUP BY currency`,[start]),
    pool.query(`SELECT model, COUNT(*)::int AS calls, SUM(prompt_tokens + completion_tokens)::bigint AS tokens, SUM(cost_usd)::numeric AS cost_usd, COUNT(*) FILTER (WHERE NOT ok)::int AS failed_calls FROM llm_usage WHERE at >= $1::timestamptz AND at < $1::timestamptz + interval '1 month' GROUP BY model`,[start]),
    pool.query('SELECT COALESCE(SUM(spend_usd),0)::numeric AS cost_usd FROM user_captcha_usage WHERE month=$1',[month]),
    pool.query(`SELECT status, COUNT(*)::int AS count FROM applications WHERE created_at >= $1::timestamptz AND created_at < $1::timestamptz + interval '1 month' GROUP BY status`,[start]),
    pool.query("SELECT key,value FROM app_settings WHERE key IN ('llm.prices','payments.packs','credits.cost_per_application')"),
  ]);
  const overrides = new Map(settings.rows.map(r=>[r.key,r.value]));
  const prices = overrides.get('llm.prices') ?? SETTINGS['llm.prices'].default;
  const packs = overrides.get('payments.packs') ?? SETTINGS['payments.packs'].default;
  const creditsPerApplication = Number(overrides.get('credits.cost_per_application') ?? SETTINGS['credits.cost_per_application'].default);
  const unpriced = llm.rows.filter(r=>!prices[r.model] && Number(r.cost_usd) === 0 && Number(r.tokens)>0);
  const revenue={USD:0,INR:0}; for(const r of payments.rows) if(r.currency in revenue) revenue[r.currency as keyof typeof revenue]+=Number(r.receipts);
  console.log(JSON.stringify({month,basis:'UTC calendar month; recorded cash receipts, not recognized profit',payments:payments.rows,llm:llm.rows,captchaRecordedUsd:Number(captcha.rows[0].cost_usd),applications:applications.rows,
    economics:calculateEconomics(revenue,llm.rows.reduce((n,r)=>n+Number(r.cost_usd),0),Number(captcha.rows[0].cost_usd),inputs,unpriced.reduce((n,r)=>n+r.calls,0)),
    packUnitRevenue:packs.map((p:any)=>({id:p.id,credits:p.credits,perCredit:Object.fromEntries(Object.entries(p.prices).map(([c,v])=>[c,Number(v)/100/p.credits])),perApplication:Object.fromEntries(Object.entries(p.prices).map(([c,v])=>[c,Number(v)/100/p.credits*creditsPerApplication]))})),
    limitations:['Vendor invoices must be reconciled: older empty replies and failed CAPTCHA attempts may be missing.','Configured zero model prices need confirmation from the provider.','Cash receipts from credit sales are not recognized revenue; unused credits create future delivery obligations.','No production measurement is implied when run against a staging database.'],unpricedModels:unpriced.map(r=>r.model)
  },null,2));
} finally { await pool.end(); }
