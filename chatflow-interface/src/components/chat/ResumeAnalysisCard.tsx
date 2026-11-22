import { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertCircle, Check, Loader2, Sparkles } from "lucide-react";
import { toast } from "sonner";
import { jp, type ResumeAnalysisDTO } from "@/lib/api-client";

const ANSWERS: { key: "aboutYou" | "strengths" | "achievement" | "careerGoal"; label: string }[] = [
  { key: "aboutYou", label: "Tell us about yourself" },
  { key: "strengths", label: "Your strengths" },
  { key: "achievement", label: "Biggest achievement" },
  { key: "careerGoal", label: "Career goals" },
];

const DOT = { high: "bg-destructive", medium: "bg-amber-500", low: "bg-faint" } as const;

/**
 * How strong the résumé is, how much of a typical application it already answers, and the personal answers
 * prepared from it. The analysis is free (rules); "Prepare answers" may use one small model call, only when
 * the résumé facts changed.
 */
export function ResumeAnalysisCard({ autoPrepare = false }: { autoPrepare?: boolean }) {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["resume-analysis"], queryFn: jp.resumeAnalysis, staleTime: 15_000 });
  const [busy, setBusy] = useState(false);
  const ran = useRef(false);

  const prepare = async (quiet = false) => {
    setBusy(true);
    try {
      const next = await jp.optimizeResume();
      qc.setQueryData<ResumeAnalysisDTO>(["resume-analysis"], next);
      if (!quiet) toast.success("Answers prepared from your résumé");
    } catch (e) {
      if (!quiet) toast.error((e as Error).message || "Couldn't prepare answers");
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    if (autoPrepare && !ran.current) {
      ran.current = true;
      void prepare(true);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoPrepare]);

  if (q.isLoading) {
    return (
      <div className="grid h-28 place-items-center rounded-[18px] border border-border bg-card">
        <Loader2 className="h-4 w-4 animate-spin text-faint" />
      </div>
    );
  }
  if (!q.data) return null;
  const { analysis: a, answerBank: bank } = q.data;
  const tone = a.score >= 80 ? "text-success" : a.score >= 60 ? "text-foreground" : "text-destructive";

  return (
    <section className="overflow-hidden rounded-[18px] border border-border bg-card text-left">
      <div className="flex items-center gap-4 p-4">
        <div className="grid h-16 w-16 shrink-0 place-items-center rounded-full border-4 border-muted">
          <span className={`text-[22px] font-bold tabular-nums ${tone}`}>{a.score}</span>
        </div>
        <div className="min-w-0 flex-1">
          <p className="text-[14px] font-semibold text-foreground">Résumé: {a.label}</p>
          <p className="mt-0.5 text-[12.5px] text-muted-foreground">
            Your profile already answers <b className="text-foreground">{a.coverage.percent}%</b> of what applications ask ({a.coverage.answered} of {a.coverage.total}).
          </p>
          <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-muted">
            <div className="h-full rounded-full bg-primary transition-[width] duration-500" style={{ width: `${a.coverage.percent}%` }} />
          </div>
        </div>
      </div>

      {a.findings.length > 0 && (
        <div className="border-t border-border px-4 py-3">
          <p className="mb-2 text-[12px] font-medium uppercase tracking-wide text-faint">Improve first</p>
          <ul className="space-y-2.5">
            {a.findings.slice(0, 4).map((f) => (
              <li key={f.id} className="flex gap-2.5 text-[13px]">
                <span className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${DOT[f.severity]}`} />
                <span>
                  <span className="font-medium text-foreground">{f.title}.</span> <span className="text-muted-foreground">{f.fix}</span>
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {a.keywords.consider.length >= 3 && (
        <div className="border-t border-border px-4 py-3 text-[12.5px] text-muted-foreground">
          Roles like yours often list: <span className="text-foreground">{a.keywords.consider.join(", ")}</span>. Add only what you really use.
        </div>
      )}

      {a.strengths.length > 0 && (
        <div className="flex flex-wrap gap-1.5 border-t border-border px-4 py-3">
          {a.strengths.map((s) => (
            <span key={s} className="inline-flex items-center gap-1 rounded-full bg-muted px-2.5 py-1 text-[12px] text-ink-2">
              <Check className="h-3 w-3 text-success" /> {s}
            </span>
          ))}
        </div>
      )}

      <div className="border-t border-border px-4 py-3">
        <div className="mb-2 flex items-center justify-between gap-2">
          <p className="text-[12px] font-medium uppercase tracking-wide text-faint">Ready-made answers</p>
          <button
            onClick={() => void prepare()}
            disabled={busy}
            className="inline-flex items-center gap-1.5 rounded-full border border-border px-3 py-1 text-[12px] font-medium text-foreground hover:border-faint disabled:opacity-50"
          >
            {busy ? <Loader2 className="h-3 w-3 animate-spin" /> : <Sparkles className="h-3 w-3" />}
            {bank ? "Refresh" : "Prepare answers"}
          </button>
        </div>
        {bank ? (
          <div className="space-y-3">
            {ANSWERS.map(({ key, label }) => (bank[key] ? <AnswerRow key={key} id={key} label={label} value={bank[key]!} onSaved={() => qc.invalidateQueries({ queryKey: ["resume-analysis"] })} /> : null))}
            <p className="text-[11.5px] text-faint">
              {bank.source === "ai" ? "Wording polished once by AI from your résumé facts." : "Written from your résumé."} Used on every application with no AI call. Edit any of them; yours are never overwritten.
            </p>
          </div>
        ) : (
          <p className="text-[12.5px] text-muted-foreground">Prepared from your résumé so applications never stop to ask.</p>
        )}
      </div>

      {q.data.missing.length > 0 && (
        <div className="flex gap-2 border-t border-border bg-muted/40 px-4 py-3 text-[12.5px] text-muted-foreground">
          <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          Still needed: {q.data.missing.map((m) => m.label).join(", ")}.
        </div>
      )}
    </section>
  );
}

function AnswerRow({ id, label, value, onSaved }: { id: string; label: string; value: string; onSaved: () => void }) {
  const [text, setText] = useState(value);
  useEffect(() => setText(value), [value]);
  return (
    <label className="block">
      <span className="mb-1 block text-[12px] font-medium text-foreground">{label}</span>
      <textarea
        value={text}
        rows={3}
        onChange={(e) => setText(e.target.value)}
        onBlur={async () => {
          if (text.trim() === value.trim() || !text.trim()) return;
          try {
            await jp.saveAnswer(id, text);
            onSaved();
          } catch {
            toast.error("Couldn't save that answer");
          }
        }}
        className="w-full resize-none rounded-xl border border-border bg-background px-3 py-2 text-[13px] leading-snug text-foreground outline-none focus:border-primary"
      />
    </label>
  );
}
