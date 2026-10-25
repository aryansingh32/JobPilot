import { useEffect, useRef, useState } from "react";
import type { JobPulseDTO } from "@/lib/api-client";
import { useJobPulse } from "@/lib/live";

/**
 * The live line under the greeting: what's opening for *this* person, in
 * words — not a dashboard counter. Numbers count up when they change; the
 * newest matches drift past one at a time.
 */
export function JobPulse() {
  const { data, isLoading } = useJobPulse();
  if (isLoading) return <PulseSkeleton />;
  if (!data) return null;
  return <PulseBody p={data} />;
}

const fmt = (n: number) => n.toLocaleString("en-IN");

function useReducedMotion() {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    const m = window.matchMedia?.("(prefers-reduced-motion: reduce)");
    setReduced(!!m?.matches);
    const on = (e: MediaQueryListEvent) => setReduced(e.matches);
    m?.addEventListener?.("change", on);
    return () => m?.removeEventListener?.("change", on);
  }, []);
  return reduced;
}

/** Counts from the last shown value to the new one (first paint counts up from ~70%). */
function useCountUp(target: number, ms = 900) {
  const reduced = useReducedMotion();
  const [value, setValue] = useState(() => (reduced ? target : Math.round(target * 0.7)));
  const from = useRef(value);
  useEffect(() => {
    if (reduced) {
      setValue(target);
      return;
    }
    const start = performance.now();
    const a = from.current;
    let raf = 0;
    const tick = (t: number) => {
      const k = Math.min(1, (t - start) / ms);
      const eased = 1 - Math.pow(1 - k, 3);
      const v = Math.round(a + (target - a) * eased);
      setValue(v);
      if (k < 1) raf = requestAnimationFrame(tick);
      else from.current = target;
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [target, ms, reduced]);
  return value;
}

function N({ value, strong = true }: { value: number; strong?: boolean }) {
  const v = useCountUp(value);
  return <span className={`tabular-nums ${strong ? "font-semibold text-foreground" : ""}`}>{fmt(v)}</span>;
}

function ago(iso: string | null): string {
  if (!iso) return "a moment ago";
  const m = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60000));
  if (m < 1) return "just now";
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  return h < 24 ? `${h}h ago` : `${Math.round(h / 24)}d ago`;
}

/** "a Software Engineer" / "an Android Developer" */
const withArticle = (role: string) => `${/^[aeiou]/i.test(role) ? "an" : "a"} ${role}`;

function Headline({ p }: { p: JobPulseDTO }) {
  const who = p.role ? ` for ${withArticle(p.role)} like you` : " that fit you";
  if (p.fitsNewToday > 0) {
    return (
      <>
        Since yesterday, <N value={p.fitsNewToday} /> new {p.fitsNewToday === 1 ? "role has" : "roles have"} opened{who}
        {p.fitCompanies > 1 ? (
          <>
            {" "}— at <N value={p.fitCompanies} /> different companies.
          </>
        ) : (
          "."
        )}
      </>
    );
  }
  if (p.fits > 0) {
    const window = p.fitsWindowDays <= 1 ? "today" : `in the last ${p.fitsWindowDays} days`;
    return (
      <>
        <N value={p.fits} /> {p.fits === 1 ? "role" : "roles"} posted {window} fit what you do. I'll flag the next one the moment it opens.
      </>
    );
  }
  return <>Nothing fits just yet — tell me the role you want, or add your résumé, and I'll start watching for it.</>;
}

function CityLine({ city }: { city: NonNullable<JobPulseDTO["city"]> }) {
  if (!city.roles) return null;
  return (
    <>
      In {city.name}, <N value={city.companies} strong={false} /> companies are hiring right now
      {city.newToday > 0 ? (
        <>
          {" "}— <N value={city.newToday} strong={false} /> roles went up today.
        </>
      ) : (
        "."
      )}
    </>
  );
}

/** One newest match at a time, cross-fading. */
function JustIn({ items }: { items: JobPulseDTO["latest"] }) {
  const [i, setI] = useState(0);
  const reduced = useReducedMotion();
  useEffect(() => {
    if (items.length < 2 || reduced) return;
    const t = setInterval(() => setI((n) => (n + 1) % items.length), 4500);
    return () => clearInterval(t);
  }, [items.length, reduced]);
  if (!items.length) return null;
  const it = items[i % items.length];
  return (
    <div className="mt-3 flex min-w-0 items-center gap-2 text-[13px]" aria-live="polite">
      <span className="shrink-0 rounded-full bg-muted px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wide text-ink-2">
        Just in
      </span>
      <span key={it.id} className="min-w-0 truncate text-muted-foreground animate-in fade-in-0 slide-in-from-bottom-1 duration-500">
        <span className="font-medium text-foreground">{it.company}</span> is looking for{" "}
        <span className="font-medium text-foreground">{it.title}</span>
        {it.location ? <> · {shortLocation(it.location)}</> : null}
        <span className="text-faint"> · {ago(it.seenAt)}</span>
      </span>
    </div>
  );
}

/** "Bengaluru - Karnataka, India - Kalyani Platina" → "Bengaluru" */
function shortLocation(loc: string): string {
  const first = loc.split(/[;|]/)[0].split(/\s[-–]\s|,/)[0].trim();
  return first.length > 2 ? first : loc;
}

function PulseBody({ p }: { p: JobPulseDTO }) {
  return (
    <div className="mb-5 rounded-[18px] border border-border bg-card/80 px-4 py-3.5 text-left shadow-[0_1px_2px_rgba(13,24,40,0.04)] backdrop-blur-sm sm:px-5">
      <p className="text-[15px] leading-relaxed text-ink-2">
        <span className="relative mr-2 inline-flex h-2 w-2 translate-y-[-1px] align-middle" aria-hidden>
          <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-success opacity-60 motion-reduce:animate-none" />
          <span className="relative inline-flex h-2 w-2 rounded-full bg-success" />
        </span>
        <Headline p={p} />
      </p>
      {p.city ? (
        <p className="mt-1 text-[13.5px] leading-relaxed text-muted-foreground">
          <CityLine city={p.city} />
        </p>
      ) : null}
      <JustIn items={p.latest} />
      <p className="mt-3 border-t border-border pt-2.5 text-[12px] text-faint">
        I'm keeping an eye on the career pages of <N value={p.platform.companies} strong={false} /> companies for you
        {p.platform.addedLastHour > 0 ? (
          <>
            {" "}· <N value={p.platform.addedLastHour} strong={false} /> new openings in the last hour
          </>
        ) : null}{" "}
        · last look {ago(p.platform.checkedAt)}
      </p>
    </div>
  );
}

function PulseSkeleton() {
  return (
    <div className="mb-5 rounded-[18px] border border-border bg-card/80 px-4 py-3.5 sm:px-5" aria-hidden>
      <div className="h-4 w-4/5 animate-pulse rounded bg-muted" />
      <div className="mt-2 h-3.5 w-3/5 animate-pulse rounded bg-muted" />
      <div className="mt-4 h-3 w-2/5 animate-pulse rounded bg-muted" />
    </div>
  );
}
