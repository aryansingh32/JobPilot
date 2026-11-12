// The one-page record of a submitted application, as HTML (rendered to PDF by the worker). Pure and escaped:
// every value on it came from a website or a person.

export interface SummaryInput {
  title: string;
  company: string | null;
  url: string | null;
  submittedAt: Date;
  confirmation: string | null;
  reference: string | null;
  answers: { label: string; value: string; source: string }[];
  /** PNG of the confirmation page, base64. */
  receiptPng?: string | null;
}

export const esc = (s: unknown) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

const SOURCE: Record<string, string> = {
  profile: 'Your profile',
  memory: 'Your earlier answer',
  user: 'You',
  default: 'Standard answer',
  prefilled: 'Already on the form',
  ai: 'Written by AI from your notes',
};

export function summaryHtml(s: SummaryInput): string {
  const when = s.submittedAt.toLocaleString('en-GB', { dateStyle: 'long', timeStyle: 'short', timeZone: 'UTC' }) + ' UTC';
  const rows = s.answers
    .filter((a) => a.value)
    .map((a) => `<tr><td>${esc(a.label)}</td><td>${esc(a.value.length > 400 ? a.value.slice(0, 400) + '…' : a.value)}</td><td class="src">${esc(SOURCE[a.source] ?? a.source)}</td></tr>`)
    .join('');
  return `<!doctype html><html><head><meta charset="utf-8"><style>
    body{font:13px/1.45 -apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#16181d;margin:0;padding:34px 38px}
    h1{font-size:21px;margin:0 0 2px} .sub{color:#5b6270;margin:0 0 18px}
    .ok{display:inline-block;background:#e6f6ec;color:#17693a;border-radius:999px;padding:3px 12px;font-weight:600;font-size:12px;margin-bottom:14px}
    dl{display:grid;grid-template-columns:150px 1fr;gap:5px 14px;margin:0 0 20px} dt{color:#5b6270} dd{margin:0;word-break:break-word}
    h2{font-size:14px;margin:22px 0 8px} table{width:100%;border-collapse:collapse;font-size:12px}
    td{padding:6px 8px;border-bottom:1px solid #e7e9ee;vertical-align:top} td:first-child{width:36%;color:#3b4150} td.src{width:22%;color:#7a8190}
    img{max-width:100%;border:1px solid #e1e4ea;border-radius:6px} .foot{margin-top:22px;color:#8a909d;font-size:11px}
  </style></head><body>
    <div class="ok">✓ Application submitted</div>
    <h1>${esc(s.title)}</h1><p class="sub">${esc(s.company ?? '')}</p>
    <dl>
      <dt>Submitted</dt><dd>${esc(when)}</dd>
      <dt>The site said</dt><dd>${esc(s.confirmation ?? 'Confirmed')}</dd>
      ${s.reference ? `<dt>Reference</dt><dd>${esc(s.reference)}</dd>` : ''}
      ${s.url ? `<dt>Posting</dt><dd>${esc(s.url)}</dd>` : ''}
    </dl>
    <h2>What was sent (${s.answers.filter((a) => a.value).length} answer${s.answers.filter((a) => a.value).length === 1 ? "" : "s"})</h2>
    <table>${rows || '<tr><td colspan="3">No answers recorded.</td></tr>'}</table>
    ${s.receiptPng ? `<h2>The confirmation page</h2><img src="data:image/png;base64,${s.receiptPng}" alt="Confirmation page">` : ''}
    <p class="foot">Prepared by JobPilot from what was filled in on the form. Keep this for your records.</p>
  </body></html>`;
}
