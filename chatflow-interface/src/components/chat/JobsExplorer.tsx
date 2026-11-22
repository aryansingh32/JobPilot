import { useEffect, useState } from "react";
import { useInfiniteQuery } from "@tanstack/react-query";
import { Loader2, MapPin, Search, SearchX, X } from "lucide-react";
import { jp, type JobListingDTO, type JobSearchParams } from "@/lib/api-client";
import { JobCard } from "./JobsHome";

const WORKPLACE = ["Any", "Remote", "Hybrid", "On-site"] as const;
const TYPES = ["Any", "Full-time", "Part-time", "Contract", "Intern"] as const;

function useDebounced<T>(value: T, ms = 350): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

function Chips<T extends string>({
  label,
  options,
  value,
  onChange,
}: {
  label: string;
  options: readonly T[];
  value: T;
  onChange: (v: T) => void;
}) {
  return (
    <div className="flex items-center gap-2">
      <span className="shrink-0 text-[12px] font-medium text-faint">{label}</span>
      <div className="no-scrollbar flex gap-1.5 overflow-x-auto">
        {options.map((o) => (
          <button
            key={o}
            onClick={() => onChange(o)}
            className={`shrink-0 rounded-full border px-3 py-1 text-[12px] font-semibold transition-colors ${
              value === o
                ? "border-primary bg-primary text-primary-foreground"
                : "border-border bg-card text-ink-2 hover:border-faint"
            }`}
          >
            {o}
          </button>
        ))}
      </div>
    </div>
  );
}

/** Every open role: search, filter, and open any card for the full details. */
export function JobsExplorer({
  initialSearch,
  savedIds,
  onOpen,
  onApply,
  onToggleSave,
}: {
  initialSearch?: JobSearchParams & { country?: string; includeRemote?: boolean; experienceLevel?: "fresher" } | null;
  savedIds: Set<string>;
  onOpen: (job: JobListingDTO) => void;
  onApply: (job: JobListingDTO) => void;
  onToggleSave: (job: JobListingDTO) => void;
}) {
  const [text, setText] = useState(initialSearch?.q ?? "");
  const [where, setWhere] = useState(initialSearch?.location ?? "");
  const [workplace, setWorkplace] = useState<(typeof WORKPLACE)[number]>(initialSearch?.workplace === "Remote" ? "Remote" : "Any");
  const [type, setType] = useState<(typeof TYPES)[number]>("Any");
  const [country, setCountry] = useState(initialSearch?.country);
  const [includeRemote, setIncludeRemote] = useState(initialSearch?.includeRemote);
  const [experienceLevel, setExperienceLevel] = useState(initialSearch?.experienceLevel);
  const q = useDebounced(text.trim());
  const location = useDebounced(where.trim());
  const [passed, setPassed] = useState<Set<string>>(() => new Set());

  const query = useInfiniteQuery({
    queryKey: ["jobs-search", q, location, workplace, type, country, includeRemote, experienceLevel],
    initialPageParam: 1,
    queryFn: ({ pageParam }) =>
      jp.searchJobs({
        q,
        location,
        workplace: workplace === "Any" ? undefined : workplace,
        type: type === "Any" ? undefined : type,
        country,
        includeRemote,
        experienceLevel,
        page: pageParam,
      }),
    getNextPageParam: (last) => (last.hasMore ? last.page + 1 : undefined),
    staleTime: 60_000,
  });
  const jobs = (query.data?.pages.flatMap((p) => p.jobs) ?? []).filter((j) => !passed.has(j.id));
  const filtered = !!(q || location || workplace !== "Any" || type !== "Any" || country || includeRemote || experienceLevel);

  return (
    <div className="scroll-thin flex-1 overflow-y-auto px-4 pb-10">
      <div className="mx-auto w-full max-w-[72rem] animate-in fade-in-0 duration-300">
        <div className="sticky top-0 z-10 -mx-4 space-y-3 bg-background/95 px-4 pb-3 pt-4 backdrop-blur">
          <div className="grid gap-2 sm:grid-cols-[1fr_240px]">
            <label className="flex h-11 items-center gap-2 rounded-full border border-border bg-card px-4 focus-within:border-primary">
              <Search className="h-4 w-4 shrink-0 text-faint" />
              <input
                value={text}
                onChange={(e) => setText(e.target.value)}
                placeholder="Role, skill or company"
                className="min-w-0 flex-1 bg-transparent text-[14px] outline-none placeholder:text-faint"
              />
              {text && (
                <button
                  onClick={() => setText("")}
                  aria-label="Clear search"
                  className="text-faint hover:text-foreground"
                >
                  <X className="h-4 w-4" />
                </button>
              )}
            </label>
            <label className="flex h-11 items-center gap-2 rounded-full border border-border bg-card px-4 focus-within:border-primary">
              <MapPin className="h-4 w-4 shrink-0 text-faint" />
              <input
                value={where}
                onChange={(e) => setWhere(e.target.value)}
                placeholder="City or country"
                className="min-w-0 flex-1 bg-transparent text-[14px] outline-none placeholder:text-faint"
              />
            </label>
          </div>
          <div className="flex flex-col gap-2 sm:flex-row sm:gap-6">
            <Chips label="Work" options={WORKPLACE} value={workplace} onChange={setWorkplace} />
            <Chips label="Type" options={TYPES} value={type} onChange={setType} />
          </div>
          {(country || includeRemote || experienceLevel) && (
            <div className="flex flex-wrap gap-1.5" aria-label="Applied search filters">
              {country && <span className="rounded-full bg-primary-soft px-2.5 py-1 text-[11px] font-medium text-primary-soft-foreground">India</span>}
              {includeRemote && <span className="rounded-full bg-primary-soft px-2.5 py-1 text-[11px] font-medium text-primary-soft-foreground">Remote</span>}
              {experienceLevel && <span className="rounded-full bg-primary-soft px-2.5 py-1 text-[11px] font-medium text-primary-soft-foreground">Freshers</span>}
            </div>
          )}
        </div>

        {query.isLoading ? (
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {Array.from({ length: 9 }, (_, i) => (
              <div
                key={i}
                className="h-[230px] animate-pulse rounded-[18px] border border-border bg-card"
              />
            ))}
          </div>
        ) : query.isError ? (
          <Empty
            title="Couldn't load jobs"
            body="Check your connection and try again."
            action={{ label: "Try again", run: () => void query.refetch() }}
          />
        ) : jobs.length === 0 ? (
          <Empty
            title={filtered ? "Nothing matches those filters" : "No open roles yet"}
            body={
              filtered
                ? "Try a broader search or clear a filter."
                : "New roles arrive every few minutes."
            }
            action={
              filtered
                ? {
                    label: "Clear filters",
                    run: () => {
                      setText("");
                      setWhere("");
                      setWorkplace("Any");
                      setType("Any");
                      setCountry(undefined);
                      setIncludeRemote(undefined);
                      setExperienceLevel(undefined);
                    },
                  }
                : undefined
            }
          />
        ) : (
          <>
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {jobs.map((j, i) => (
                <JobCard
                  key={j.id}
                  index={i}
                  job={j}
                  grid
                  saved={savedIds.has(j.id)}
                  onOpen={onOpen}
                  onApply={onApply}
                  onToggleSave={onToggleSave}
                  onPass={(job) => setPassed((p) => new Set(p).add(job.id))}
                />
              ))}
            </div>
            {query.hasNextPage && (
              <div className="mt-6 flex justify-center">
                <button
                  onClick={() => void query.fetchNextPage()}
                  disabled={query.isFetchingNextPage}
                  className="flex h-11 items-center gap-2 rounded-full border border-border bg-card px-6 text-[14px] font-semibold text-foreground hover:border-faint disabled:opacity-60"
                >
                  {query.isFetchingNextPage && <Loader2 className="h-4 w-4 animate-spin" />}
                  Show more jobs
                </button>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

function Empty({
  title,
  body,
  action,
}: {
  title: string;
  body: string;
  action?: { label: string; run: () => void };
}) {
  return (
    <div className="mx-auto mt-16 flex max-w-sm flex-col items-center text-center">
      <span className="grid h-12 w-12 place-items-center rounded-2xl bg-muted text-muted-foreground">
        <SearchX className="h-6 w-6" />
      </span>
      <p className="mt-3 text-[15px] font-semibold text-foreground">{title}</p>
      <p className="mt-1 text-[13px] text-muted-foreground">{body}</p>
      {action && (
        <button
          onClick={action.run}
          className="mt-4 rounded-full bg-primary px-5 py-2 text-[13px] font-semibold text-primary-foreground"
        >
          {action.label}
        </button>
      )}
    </div>
  );
}
