import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, Loader2, Sparkles } from "lucide-react";
import { toast } from "sonner";
import { jp } from "@/lib/api-client";

export const ABOUT_PLACEHOLDER = `Anything employers tend to ask, in your own words. For example:
• Passing out year 2027, CGPA 8.4, no backlogs
• Open to relocate anywhere; hybrid or remote both fine
• I don't need visa sponsorship in India
• Experienced with React, Node, Postgres; built X that did Y
• Pronouns: prefer not to say
• How I heard about jobs: LinkedIn`;

/** The free-text box itself — used in onboarding and Settings. */
export function AboutYouField({
  value,
  onChange,
  rows = 7,
}: {
  value: string;
  onChange: (v: string) => void;
  rows?: number;
}) {
  return (
    <textarea
      value={value}
      onChange={(e) => onChange(e.target.value.slice(0, 4000))}
      rows={rows}
      placeholder={ABOUT_PLACEHOLDER}
      className="w-full resize-y rounded-xl border border-border bg-background p-3 text-[13.5px] leading-relaxed text-foreground outline-none placeholder:text-faint focus:border-primary"
    />
  );
}

/** "Tell us more about you": saved to the profile; the AI answers form questions from it instead of asking. */
export function AboutYouCard() {
  const qc = useQueryClient();
  const { data } = useQuery({ queryKey: ["profile"], queryFn: () => jp.profile() });
  const saved = data?.data.about ?? "";
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => setText(saved), [saved]);

  const save = async () => {
    setBusy(true);
    try {
      await jp.patchProfile({ about: text.trim() });
      await qc.invalidateQueries({ queryKey: ["profile"] });
      toast.success("Saved — I'll use this to answer application questions");
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="rounded-[18px] border border-border bg-card p-4">
      <div className="flex items-start gap-3">
        <span className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-muted text-ink-2">
          <Sparkles className="h-4 w-4" />
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-[14px] font-semibold text-foreground">Tell us more about you</p>
          <p className="mt-0.5 text-[13px] text-muted-foreground">
            Write whatever employers usually ask. I answer application questions from this instead of stopping to ask you.
            Only used on applications you send.
          </p>
          <div className="mt-3">
            <AboutYouField value={text} onChange={setText} />
          </div>
          <div className="mt-2 flex items-center justify-between">
            <span className="text-[11px] text-faint">{text.length}/4000</span>
            <button
              onClick={save}
              disabled={busy || text.trim() === saved.trim()}
              className="inline-flex h-9 items-center gap-1.5 rounded-full bg-primary px-4 text-[13px] font-semibold text-primary-foreground disabled:opacity-50"
            >
              {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />} Save
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
