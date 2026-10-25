import { useRef } from "react";
import { JobPulse } from "./JobPulse";
import {
  Bookmark,
  BookmarkCheck,
  Briefcase,
  ChevronLeft,
  ChevronRight,
  CircleAlert,
  CircleCheck,
  FileUp,
  Loader2,
  Link2,
  MapPin,
  X,
  XCircle,
} from "lucide-react";
import { closesIn, jobTint } from "@/lib/job-color";
import { displayCompany } from "@/lib/company";
import { CompanyLogo } from "@/components/chat/CompanyLogo";
import type { ApplicationSummary, JobListingDTO } from "@/lib/api-client";
import { appStatus, appSummary, ts } from "@/lib/live";
import type { TaskStatus } from "@/lib/task-status";
import { OutcomeBadge } from "./OutcomeBadge";
import { ApplyBar } from "./ApplyTracker";

/* ── Horizontal row ─────────────────────────────────────────── */

/**
 * Section with a horizontally scrolling row of cards: swipe on phones
 * (next card peeks in), arrow buttons on desktop.
 */
export function CardRow({
  title,
  subtitle,
  action,
  children,
}: {
  title: string;
  subtitle?: string;
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const scroll = (dir: 1 | -1) =>
    ref.current?.scrollBy({ left: dir * ref.current.clientWidth * 0.8, behavior: "smooth" });
  return (
    <section className="mt-8">
      <div className="mb-3 flex items-end gap-3 px-1">
        <div className="min-w-0 flex-1">
          <h2 className="text-[16px] font-bold tracking-tight text-foreground">{title}</h2>
          {subtitle && <p className="text-[12px] text-muted-foreground">{subtitle}</p>}
        </div>
        {action}
        <div className="hidden gap-1 md:flex">
          <button
            onClick={() => scroll(-1)}
            className="grid h-8 w-8 place-items-center rounded-full border border-border bg-card text-ink-2 hover:border-faint"
            aria-label={`Scroll ${title} left`}
          >
            <ChevronLeft className="h-4 w-4" />
          </button>
          <button
            onClick={() => scroll(1)}
            className="grid h-8 w-8 place-items-center rounded-full border border-border bg-card text-ink-2 hover:border-faint"
            aria-label={`Scroll ${title} right`}
          >
            <ChevronRight className="h-4 w-4" />
          </button>
        </div>
      </div>
      <div
        ref={ref}
        className="no-scrollbar -mx-4 -mt-1.5 flex snap-x snap-mandatory gap-3 overflow-x-auto scroll-px-4 px-4 pb-2 pt-1.5 md:mx-0 md:scroll-px-0 md:px-0"
      >
        {children}
      </div>
    </section>
  );
}

/* ── Job card ───────────────────────────────────────────────── */

export function MatchRing({ score }: { score: number }) {
  const r = 17;
  const c = 2 * Math.PI * r;
  const tone = score >= 80 ? "text-success" : score >= 65 ? "text-primary" : "text-faint";
  return (
    <span className="relative grid h-11 w-11 shrink-0 place-items-center" title={`${score}% match`}>
      <svg viewBox="0 0 40 40" className="absolute inset-0 -rotate-90">
        <circle cx="20" cy="20" r={r} fill="none" strokeWidth="3" className="stroke-muted" />
        <circle
          cx="20"
          cy="20"
          r={r}
          fill="none"
          strokeWidth="3"
          strokeLinecap="round"
          strokeDasharray={c}
          strokeDashoffset={c * (1 - score / 100)}
          className={`stroke-current ${tone}`}
        />
      </svg>
      <span className="text-[11px] font-bold leading-none text-foreground">
        {score}
        <span className="text-[8px]">%</span>
      </span>
    </span>
  );
}

export function JobCard({
  job,
  saved,
  grid = false,
  index,
  onOpen,
  onApply,
  onToggleSave,
  onPass,
}: {
  index?: number;
  job: JobListingDTO;
  saved: boolean;
  /** Fill its grid cell instead of the fixed width used in a scrolling row. */
  grid?: boolean;
  onOpen: (job: JobListingDTO) => void;
  onApply: (job: JobListingDTO) => void;
  onToggleSave: (job: JobListingDTO) => void;
  onPass: (job: JobListingDTO) => void;
}) {
  // Buttons inside the card do their own thing; everything else opens the details.
  const stop = (fn: () => void) => (e: React.MouseEvent) => {
    e.stopPropagation();
    fn();
  };
  const closes = closesIn(job.closesAt);
  return (
    <article
      role="button"
      tabIndex={0}
      onClick={() => onOpen(job)}
      onKeyDown={(e) => {
        if (e.target === e.currentTarget && (e.key === "Enter" || e.key === " ")) {
          e.preventDefault();
          onOpen(job);
        }
      }}
      style={jobTint(job, index)}
      className={`job-tint flex cursor-pointer flex-col rounded-[18px] border p-4 shadow-[0_1px_2px_rgba(13,24,40,0.04)] transition-all hover:-translate-y-0.5 focus-visible:outline-2 focus-visible:outline-primary ${
        grid ? "" : "w-[80%] shrink-0 snap-start sm:w-[300px]"
      }`}
    >
      <div className="flex items-start gap-3">
        <CompanyLogo company={displayCompany(job.company)} url={job.url} />
        <div className="min-w-0 flex-1">
          <div
            className="line-clamp-2 text-[13px] font-semibold leading-tight text-ink-2"
            title={displayCompany(job.company)}
          >
            {displayCompany(job.company)}
          </div>
          <div className="text-[11px] text-faint">
            {job.postedAt ? postedAgo(job.postedAt) : "Recently posted"}
          </div>
        </div>
        {job.matchScore !== undefined && <MatchRing score={job.matchScore} />}
        <button
          onClick={stop(() => onPass(job))}
          className="-mr-1 -mt-1 grid h-7 w-7 shrink-0 place-items-center rounded-full text-faint transition-colors hover:bg-muted hover:text-ink-2"
          aria-label="Not interested"
          title="Not interested"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>

      <h3 className="mt-3 line-clamp-2 min-h-[44px] text-[16px] font-bold leading-snug tracking-tight text-foreground">
        {job.title}
      </h3>

      <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[12px] text-muted-foreground">
        <span className="flex min-w-0 items-center gap-1">
          <MapPin className="h-3.5 w-3.5 shrink-0" />
          <span className="truncate">{job.location}</span>
        </span>
        {job.workplace && <span>{job.workplace}</span>}
        {job.salary && <span className="font-medium text-ink-2">{job.salary}</span>}
      </div>

      {job.matchReasons?.[0] && (
        <p className="mt-2 line-clamp-1 text-[12px] text-ink-2">{job.matchReasons[0]}</p>
      )}

      {(closes || job.vacancies) && (
        <div className="mt-2 flex flex-wrap gap-1.5">
          {closes && (
            <span
              className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${closes.urgent ? "bg-warning-soft text-warning-soft-foreground" : "job-chip"}`}
            >
              {closes.label}
            </span>
          )}
          {job.vacancies ? (
            <span className="job-chip rounded-full px-2 py-0.5 text-[11px] font-semibold">
              {job.vacancies.toLocaleString("en-IN")} vacancies
            </span>
          ) : null}
        </div>
      )}

      {job.matchedSkills?.length ? (
        <div className="mt-3 flex flex-wrap gap-1.5">
          {job.matchedSkills.slice(0, 3).map((s) => (
            <span key={s} className="job-chip rounded-full px-2 py-0.5 text-[11px] font-semibold">
              {s}
            </span>
          ))}
          {job.matchedSkills.length > 3 && (
            <span className="rounded-full bg-muted px-2 py-0.5 text-[11px] font-medium text-muted-foreground">
              +{job.matchedSkills.length - 3}
            </span>
          )}
        </div>
      ) : null}

      <div className="mt-auto flex items-center gap-2 pt-4">
        <button
          onClick={stop(() => onToggleSave(job))}
          className={`grid h-10 w-10 place-items-center rounded-full border transition-colors ${
            saved
              ? "border-primary-border bg-primary-soft text-primary-soft-foreground"
              : "border-border text-ink-2 hover:border-faint"
          }`}
          aria-label={saved ? "Saved" : "Save job"}
        >
          {saved ? <BookmarkCheck className="h-4 w-4" /> : <Bookmark className="h-4 w-4" />}
        </button>
        <button
          onClick={stop(() => onApply(job))}
          className="h-10 flex-1 rounded-full bg-primary text-[14px] font-semibold text-primary-foreground transition-all hover:opacity-90 active:scale-[0.98]"
        >
          Apply for me
        </button>
      </div>
    </article>
  );
}

function JobCardSkeleton() {
  return (
    <div className="flex h-[248px] w-[80%] shrink-0 snap-start animate-pulse flex-col rounded-[18px] border border-border bg-card p-4 sm:w-[300px]">
      <div className="flex items-center gap-3">
        <span className="h-11 w-11 rounded-xl bg-muted" />
        <span className="h-3 w-24 rounded bg-muted" />
      </div>
      <span className="mt-4 h-4 w-4/5 rounded bg-muted" />
      <span className="mt-2 h-4 w-3/5 rounded bg-muted" />
      <span className="mt-3 h-3 w-2/5 rounded bg-muted" />
      <span className="mt-auto h-10 w-full rounded-full bg-muted" />
    </div>
  );
}

/* ── Application card ───────────────────────────────────────── */

const APP_STATUS: Record<TaskStatus, { label: string; pill: string; icon: React.ReactNode }> = {
  needs: {
    label: "Needs you",
    pill: "bg-warning-soft text-warning-soft-foreground",
    icon: <CircleAlert className="h-3.5 w-3.5" />,
  },
  working: {
    label: "Applying",
    pill: "bg-primary-soft text-primary-soft-foreground",
    icon: <Loader2 className="h-3.5 w-3.5 animate-spin" />,
  },
  done: {
    label: "Submitted",
    pill: "bg-muted text-ink-2",
    icon: <CircleCheck className="h-3.5 w-3.5 text-success" />,
  },
  failed: {
    label: "Failed",
    pill: "bg-destructive/10 text-destructive",
    icon: <XCircle className="h-3.5 w-3.5" />,
  },
  idle: {
    label: "Cancelled",
    pill: "bg-muted text-muted-foreground",
    icon: <Briefcase className="h-3.5 w-3.5" />,
  },
};

export function ApplicationCard({
  app,
  onOpen,
}: {
  app: ApplicationSummary;
  onOpen: (app: ApplicationSummary) => void;
}) {
  const status = appStatus(app);
  const st =
    status === "needs" && app.status === "awaiting_review"
      ? { ...APP_STATUS.needs, label: "Review" }
      : APP_STATUS[status];
  return (
    <button
      onClick={() => onOpen(app)}
      className={`flex w-[72%] shrink-0 snap-start flex-col rounded-[18px] border bg-card p-4 text-left transition-colors hover:border-faint sm:w-[260px] ${
        status === "needs" ? "border-warning/40" : "border-border"
      }`}
    >
      <span className="flex flex-wrap items-center gap-1">
        <span
          className={`inline-flex w-fit items-center gap-1 rounded-full px-2.5 py-0.5 text-[12px] font-semibold ${st.pill}`}
        >
          {st.icon} {st.label}
        </span>
        <OutcomeBadge app={app} />
      </span>
      <span className="mt-3 line-clamp-2 text-[14px] font-semibold leading-snug text-foreground">
        {app.title || "Application"}
      </span>
      {app.company && (
        <span
          className="mt-0.5 line-clamp-2 text-[12px] font-medium text-ink-2"
          title={displayCompany(app.company)}
        >
          {displayCompany(app.company)}
        </span>
      )}
      <span className="mt-1 line-clamp-2 text-[12px] text-muted-foreground">{appSummary(app)}</span>
      {["queued", "running", "needs_input", "awaiting_review"].includes(app.status) && (
        <ApplyBar app={app} />
      )}
      <span className="mt-auto pt-3 text-[11px] text-faint">
        Updated {postedAgo(ts(app.updated_at))}
      </span>
    </button>
  );
}

/* ── Empty states ───────────────────────────────────────────── */

export function MatchesEmpty({
  onUploadResume,
  hasResume,
}: {
  onUploadResume: () => void;
  hasResume?: boolean;
}) {
  if (hasResume) {
    return (
      <div className="flex w-full shrink-0 items-center gap-3 rounded-[18px] border border-dashed border-border bg-card/60 p-5">
        <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-primary-soft text-primary-soft-foreground">
          <FileUp className="h-5 w-5" />
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-[14px] font-semibold text-foreground">No matches yet</p>
          <p className="text-[13px] text-muted-foreground">
            I'm checking company career pages for roles that fit your resume. You can browse every
            open role meanwhile.
          </p>
        </div>
      </div>
    );
  }
  return (
    <div className="flex w-full shrink-0 flex-col items-start gap-3 rounded-[18px] border border-dashed border-border bg-card/60 p-5 sm:flex-row sm:items-center">
      <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-primary-soft text-primary-soft-foreground">
        <FileUp className="h-5 w-5" />
      </span>
      <div className="min-w-0 flex-1">
        <p className="text-[14px] font-semibold text-foreground">Get job matches picked for you</p>
        <p className="text-[13px] text-muted-foreground">
          Upload your resume and I'll show roles that fit you — best matches first.
        </p>
      </div>
      <button
        onClick={onUploadResume}
        className="shrink-0 rounded-full bg-primary px-4 py-2 text-[13px] font-semibold text-primary-foreground"
      >
        Upload resume
      </button>
    </div>
  );
}

export function ApplicationsEmpty() {
  return (
    <div className="flex w-full shrink-0 items-center gap-3 rounded-[18px] border border-dashed border-border bg-card/60 p-5">
      <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-muted text-muted-foreground">
        <Link2 className="h-5 w-5" />
      </span>
      <p className="text-[13px] text-muted-foreground">
        No applications yet. Open a job and tap{" "}
        <span className="font-semibold text-foreground">Apply for me</span> — each application shows
        up here with live progress and proof.
      </p>
    </div>
  );
}

/** Posted-ago text shared by cards and the detail view. */
export function postedAgo(ts: number): string {
  const m = Math.round((Date.now() - ts) / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.round(h / 24);
  return d < 30
    ? `${d}d ago`
    : new Date(ts).toLocaleDateString(undefined, { day: "numeric", month: "short" });
}

/* ── Home screen ────────────────────────────────────────────── */

/**
 * Home: greeting + the AI prompt on top, then job matches and the user's
 * applications as horizontal rows, all from the live API.
 */
export function HomeScreen({
  greeting,
  composer,
  notice,
  jobs,
  jobsLoading,
  savedIds,
  applications: allApplications,
  onOpenJob,
  onViewMoreJobs,
  onApply,
  onToggleSave,
  onPass,
  onOpenApplication,
  onUploadResume,
  hasResume,
  onSeeAllApplications,
}: {
  greeting: string;
  composer: React.ReactNode;
  notice?: React.ReactNode;
  jobs: JobListingDTO[];
  jobsLoading: boolean;
  savedIds: Set<string>;
  applications: ApplicationSummary[];
  onOpenJob: (job: JobListingDTO) => void;
  onViewMoreJobs: () => void;
  onApply: (job: JobListingDTO) => void;
  onToggleSave: (job: JobListingDTO) => void;
  onPass: (job: JobListingDTO) => void;
  onOpenApplication: (app: ApplicationSummary) => void;
  onUploadResume: () => void;
  hasResume?: boolean;
  onSeeAllApplications: () => void;
}) {
  // Things waiting on the user first, then most recently touched.
  const applications = [...allApplications]
    .sort(
      (a, b) =>
        Number(appStatus(b) === "needs") - Number(appStatus(a) === "needs") ||
        ts(b.updated_at) - ts(a.updated_at),
    )
    .slice(0, 12);
  const needs = allApplications.filter((a) => appStatus(a) === "needs").length;

  return (
    <div className="scroll-thin relative flex-1 overflow-y-auto overflow-x-hidden px-4 pb-10">
      <div
        aria-hidden
        className="canvas-dots pointer-events-none absolute inset-x-0 top-0 h-[420px]"
      />
      <div className="relative mx-auto w-full max-w-[72rem] animate-in fade-in-0 duration-500">
        <div className="mx-auto max-w-(--chat-w) pt-6 sm:pt-[5vh]">
          <h1 className="mb-1 text-center text-[26px] font-bold tracking-tight text-foreground sm:text-[32px]">
            {greeting}
          </h1>
          <p className="mb-6 text-center text-[15px] text-muted-foreground">
            Your best matches are below. Open one, tap Apply, and I'll handle the form — you approve
            before anything is sent.
          </p>
          <JobPulse />
          {notice}
          {composer}
        </div>

        <CardRow
          title="Top matches for you"
          subtitle={jobs.length ? "Fresh roles that fit your profile" : undefined}
          action={
            <button
              onClick={onViewMoreJobs}
              className="shrink-0 rounded-full border border-border bg-card px-3 py-1 text-[13px] font-semibold text-ink-2 hover:border-faint hover:text-foreground"
            >
              View more
            </button>
          }
        >
          {jobsLoading ? (
            [0, 1, 2].map((i) => <JobCardSkeleton key={i} />)
          ) : jobs.length ? (
            jobs.map((j, i) => (
              <JobCard
                key={j.id}
                index={i}
                job={j}
                saved={savedIds.has(j.id)}
                onOpen={onOpenJob}
                onApply={onApply}
                onToggleSave={onToggleSave}
                onPass={onPass}
              />
            ))
          ) : (
            <MatchesEmpty onUploadResume={onUploadResume} hasResume={hasResume} />
          )}
        </CardRow>

        <CardRow
          title="Your applications"
          subtitle={
            applications.length
              ? needs
                ? `${needs} need${needs > 1 ? "" : "s"} you`
                : "Live status and proof for every application"
              : undefined
          }
          action={
            applications.length ? (
              <button
                onClick={onSeeAllApplications}
                className="shrink-0 text-[13px] font-semibold text-ink-2 hover:text-foreground"
              >
                See all
              </button>
            ) : undefined
          }
        >
          {applications.length ? (
            applications.map((a) => (
              <ApplicationCard key={a.id} app={a} onOpen={onOpenApplication} />
            ))
          ) : (
            <ApplicationsEmpty />
          )}
        </CardRow>
      </div>
    </div>
  );
}
