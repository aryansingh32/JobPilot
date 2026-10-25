import { jobTint } from "@/lib/job-color";
import { displayCompany } from "@/lib/company";
import { CompanyLogo } from "@/components/chat/CompanyLogo";
import { useQuery } from "@tanstack/react-query";
import {
  Bookmark,
  BookmarkCheck,
  Building2,
  Clock,
  ExternalLink,
  MapPin,
  Sparkles,
  Wallet,
} from "lucide-react";
import { Sheet, SheetContent, SheetDescription, SheetTitle } from "@/components/ui/sheet";
import { jp, type JobDetailDTO, type JobListingDTO } from "@/lib/api-client";
import { MatchRing, postedAgo } from "./JobsHome";

function experienceText(j: JobDetailDTO): string | null {
  if (j.experienceMin && j.experienceMax) return `${j.experienceMin}–${j.experienceMax} years`;
  if (j.experienceMin) return `${j.experienceMin}+ years`;
  return null;
}

/**
 * Everything about one role, in a drawer over whichever screen the card was on:
 * who, where, pay, why it fits you, and the full description.
 */
export function JobDetailSheet({
  job,
  saved,
  onClose,
  onApply,
  onToggleSave,
}: {
  job: JobListingDTO | null;
  saved: boolean;
  onClose: () => void;
  onApply: (job: JobListingDTO) => void;
  onToggleSave: (job: JobListingDTO) => void;
}) {
  const q = useQuery({
    queryKey: ["job", job?.id],
    queryFn: () => jp.job(job!.id),
    enabled: !!job,
    staleTime: 5 * 60_000,
  });
  // The card already has the headline facts, so the drawer is useful before the full record arrives.
  const detail: JobDetailDTO | null = job
    ? { description: "", skills: [], ...job, ...(q.data?.job ?? {}) }
    : null;

  return (
    <Sheet open={!!job} onOpenChange={(o) => !o && onClose()}>
      <SheetContent
        side="right"
        className="flex w-full flex-col gap-0 border-border bg-card p-0 sm:max-w-[560px]"
      >
        {detail && (
          <>
            <div
              style={jobTint(detail)}
              className="job-tint rounded-none border-0 border-b px-5 pb-4 pt-5"
            >
              <div className="flex items-start gap-3 pr-8">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2.5 text-[13px] font-semibold text-ink-2">
                    <CompanyLogo
                      company={displayCompany(detail.company)}
                      url={detail.url}
                      className="h-9 w-9 text-[14px]"
                    />
                    <span className="min-w-0 leading-tight" title={displayCompany(detail.company)}>
                      {displayCompany(detail.company)}
                    </span>
                  </div>
                  <SheetTitle className="mt-1 text-[20px] font-bold leading-snug tracking-tight text-foreground">
                    {detail.title}
                  </SheetTitle>
                  <SheetDescription className="sr-only">
                    Details for {detail.title} at {detail.company}
                  </SheetDescription>
                </div>
                {detail.matchScore !== undefined && <MatchRing score={detail.matchScore} />}
              </div>
              <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1.5 text-[13px] text-muted-foreground">
                <span className="flex items-center gap-1">
                  <MapPin className="h-3.5 w-3.5" />
                  {detail.location}
                </span>
                {detail.workplace && <span>{detail.workplace}</span>}
                {detail.employmentType && <span>{detail.employmentType}</span>}
                {detail.salary && (
                  <span className="flex items-center gap-1 font-medium text-ink-2">
                    <Wallet className="h-3.5 w-3.5" />
                    {detail.salary}
                  </span>
                )}
                {detail.postedAt && (
                  <span className="flex items-center gap-1">
                    <Clock className="h-3.5 w-3.5" />
                    {postedAgo(detail.postedAt)}
                  </span>
                )}
              </div>
            </div>

            <div className="scroll-thin flex-1 space-y-5 overflow-y-auto px-5 py-4">
              {detail.matchReasons?.length ? (
                <section className="rounded-2xl bg-primary-soft p-4">
                  <h3 className="flex items-center gap-1.5 text-[13px] font-bold text-primary-soft-foreground">
                    <Sparkles className="h-3.5 w-3.5" /> Why this fits you
                  </h3>
                  <ul className="mt-2 space-y-1 text-[13px] text-primary-soft-foreground">
                    {detail.matchReasons.map((r) => (
                      <li key={r}>• {r}</li>
                    ))}
                  </ul>
                </section>
              ) : null}

              <section className="grid grid-cols-2 gap-3 text-[13px]">
                {detail.department && <Fact label="Team" value={detail.department} />}
                {detail.seniority && <Fact label="Level" value={detail.seniority} />}
                {experienceText(detail) && (
                  <Fact label="Experience" value={experienceText(detail)!} />
                )}
                {detail.country && <Fact label="Country" value={detail.country} />}
              </section>

              {detail.skills.length > 0 && (
                <section>
                  <h3 className="mb-2 text-[13px] font-bold text-foreground">Skills</h3>
                  <div className="flex flex-wrap gap-1.5">
                    {detail.skills.slice(0, 24).map((s) => (
                      <span
                        key={s}
                        className={`rounded-full px-2.5 py-0.5 text-[12px] font-medium ${
                          detail.matchedSkills?.includes(s)
                            ? "bg-primary-soft text-primary-soft-foreground"
                            : "bg-muted text-ink-2"
                        }`}
                      >
                        {s}
                      </span>
                    ))}
                  </div>
                </section>
              )}

              <section>
                <h3 className="mb-2 text-[13px] font-bold text-foreground">About the role</h3>
                {q.isLoading ? (
                  <div className="space-y-2">
                    {[0, 1, 2, 3, 4].map((i) => (
                      <div
                        key={i}
                        className="h-3 animate-pulse rounded bg-muted"
                        style={{ width: `${95 - i * 9}%` }}
                      />
                    ))}
                  </div>
                ) : detail.description.trim() ? (
                  <p className="whitespace-pre-line text-[14px] leading-relaxed text-ink-2">
                    {detail.description.trim()}
                  </p>
                ) : (
                  <p className="text-[13px] text-muted-foreground">
                    The company didn't publish a description here —{" "}
                    <a
                      href={detail.url}
                      target="_blank"
                      rel="noreferrer"
                      className="font-semibold text-primary underline"
                    >
                      read it on their site
                    </a>
                    .
                  </p>
                )}
              </section>
            </div>

            <div className="flex items-center gap-2 border-t border-border bg-card px-5 py-3">
              <button
                onClick={() => onToggleSave(detail)}
                className={`grid h-11 w-11 shrink-0 place-items-center rounded-full border transition-colors ${
                  saved
                    ? "border-primary-border bg-primary-soft text-primary-soft-foreground"
                    : "border-border text-ink-2 hover:border-faint"
                }`}
                aria-label={saved ? "Saved" : "Save job"}
              >
                {saved ? <BookmarkCheck className="h-4 w-4" /> : <Bookmark className="h-4 w-4" />}
              </button>
              <a
                href={detail.url}
                target="_blank"
                rel="noreferrer"
                className="grid h-11 w-11 shrink-0 place-items-center rounded-full border border-border text-ink-2 hover:border-faint"
                aria-label="Open the original posting"
                title="Open the original posting"
              >
                <ExternalLink className="h-4 w-4" />
              </a>
              <button
                onClick={() => onApply(detail)}
                className="h-11 flex-1 rounded-full bg-primary text-[15px] font-semibold text-primary-foreground transition-all hover:opacity-90 active:scale-[0.98]"
              >
                Apply for me
              </button>
            </div>
          </>
        )}
      </SheetContent>
    </Sheet>
  );
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl bg-muted/60 px-3 py-2">
      <div className="text-[11px] font-medium uppercase tracking-wide text-faint">{label}</div>
      <div className="mt-0.5 font-medium text-foreground">{value}</div>
    </div>
  );
}
