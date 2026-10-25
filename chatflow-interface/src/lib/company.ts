// The hiring company, as a person would write it, and where its own website probably is.

const ACRONYMS = new Set([
  "hp",
  "ibm",
  "dbs",
  "ge",
  "sap",
  "ey",
  "pwc",
  "tcs",
  "bmw",
  "hr",
  "ai",
  "ntt",
  "kpmg",
  "nvidia",
  "amd",
  "ups",
  "aig",
  "bp",
  "at&t",
  "ssc",
  "upsc",
  "ibps",
  "rrb",
  "sbi",
  "rbi",
  "ongc",
  "ntpc",
  "bhel",
  "drdo",
  "isro",
]);
const SMALL = new Set(["of", "and", "the", "for", "de", "la"]);
/** Hosts that are an applicant system, not the company: their icon is the vendor's, never the company's. */
const ATS_HOST =
  /(myworkdayjobs|myworkday|greenhouse|lever|ashbyhq|smartrecruiters|workable|recruitee|oraclecloud|successfactors|icims|taleo|zohorecruit|freshteam|keka|jobvite|bamboohr|sarkarinaukri)\./i;

/** "globalhr" → "GlobalHR", "DBS" stays, "ffpar" → "Ffpar"; legal suffixes dropped. */
export function displayCompany(raw: string): string {
  const name = (raw ?? "").replace(/[_-]+/g, " ").replace(/\s+/g, " ").trim();
  if (!name) return "";
  // "Canvasinc" → "Canvas Inc": a legal suffix glued onto a single-word slug.
  const glued = name.match(/^([A-Za-z]{3,}?)(inc|llc|ltd|corp|gmbh|plc)$/i);
  if (glued && !name.includes(" "))
    return `${glued[1].charAt(0).toUpperCase()}${glued[1].slice(1)} ${glued[2].charAt(0).toUpperCase()}${glued[2].slice(1).toLowerCase()}`;
  // Already written with its own capitals ("GitLab", "OpenAI", "Dbs Bank"): trust it.
  if (/[A-Z]/.test(name.slice(1)) || /[a-z]/.test(name) === false) return name;
  return name
    .split(" ")
    .map((w, i) =>
      ACRONYMS.has(w.toLowerCase())
        ? w.toUpperCase()
        : SMALL.has(w) && i
          ? w
          : w.charAt(0).toUpperCase() + w.slice(1),
    )
    .join(" ");
}

/** Likely website domains for the company: its own career host if not an ATS, then a guess from the name. */
export function companyDomains(company: string, url?: string): string[] {
  const out: string[] = [];
  try {
    const host = new URL(url ?? "").hostname.replace(/^www\./, "");
    if (host && !ATS_HOST.test(`${host}.`)) {
      const parts = host.split(".");
      // careers.acme.com → acme.com; jobs.acme.co.in → acme.co.in
      out.push(
        parts.slice(/^(co|com|gov|org|ac|net)$/.test(parts.at(-2) ?? "") ? -3 : -2).join("."),
      );
    }
  } catch {
    /* no url */
  }
  const slug = company
    .toLowerCase()
    .replace(
      /\b(inc|llc|ltd|limited|corp|corporation|co|gmbh|plc|pvt|private|group|holdings?|technologies|technology|solutions)\b\.?/g,
      "",
    )
    .replace(/[^a-z0-9]/g, "");
  if (slug.length >= 2) out.push(`${slug}.com`);
  return [...new Set(out)].slice(0, 2);
}
