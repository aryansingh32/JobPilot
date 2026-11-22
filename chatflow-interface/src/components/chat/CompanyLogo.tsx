import { useMemo, useState } from "react";
import { companyDomains } from "@/lib/company";

/**
 * The hiring company's real logo when one can be found (its own site's icon),
 * else the coloured initial. Tried in order; the first that loads wins.
 */
export function CompanyLogo({
  company,
  url,
  className = "h-11 w-11 text-[16px]",
}: {
  company: string;
  url?: string;
  className?: string;
}) {
  const candidates = useMemo(
    () => companyDomains(company, url).map((d) => `https://icons.duckduckgo.com/ip3/${d}.ico`),
    [company, url],
  );
  const [failed, setFailed] = useState(0);
  const src = candidates[failed];
  return (
    <span
      className={`job-logo relative grid shrink-0 place-items-center overflow-hidden rounded-xl font-bold ${className}`}
    >
      {company.trim().slice(0, 1).toUpperCase()}
      {src && (
        <img
          key={src}
          src={src}
          alt=""
          loading="lazy"
          referrerPolicy="no-referrer"
          // A real logo sits on white so it reads in light and dark; an unknown company 404s → the initial stays.
          onError={() => setFailed((n) => n + 1)}
          className="absolute inset-0 h-full w-full bg-white object-contain p-1.5"
        />
      )}
    </span>
  );
}
