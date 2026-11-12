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
• How I heard about jobs: LinkedIn
• Previous employers: Acme, Globex  (only these are answered "Yes" to "have you worked for X before?")
• Licenses I hold: none`;

/** Lines employers ask again and again: one tap adds the line to fill in. */
const SUGGESTIONS = [
  "Passing out year: ",
  "CGPA / backlogs: ",
  "Certifications: ",
  "Open to relocate: Yes",
  "Fine with hybrid / office: Yes",
  "Pronouns: prefer not to say",
  "Gender: ",
  "How I heard about jobs: LinkedIn",
  "Anyone I know at the company: No",
  "Previous employers: ",
];

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
  const left = SUGGESTIONS.filter((s) => !value.toLowerCase().includes(s.split(":")[0].toLowerCase()));
  return (
    <div>
      <textarea
        value={value}
        onChange={(e) => onChange(e.target.value.slice(0, 4000))}
        rows={rows}
        placeholder={ABOUT_PLACEHOLDER}
        className="w-full resize-y rounded-xl border border-border bg-background p-3 text-[13.5px] leading-relaxed text-foreground outline-none placeholder:text-faint focus:border-primary"
      />
      {left.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-1.5">
          {left.map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => onChange(`${value.trimEnd()}${value.trim() ? "\n" : ""}${s}`.slice(0, 4000))}
              className="rounded-full border border-border bg-card px-2.5 py-1 text-[11.5px] text-muted-foreground hover:border-primary hover:text-foreground"
            >
              + {s.split(":")[0]}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/** "Tell us more about you": saved to the profile; the AI answers form questions from it instead of asking. */
export function AboutYouCard() {
  const qc = useQueryClient();
  const { data } = useQuery({ queryKey: ["profile"], queryFn: () => jp.profile() });
  const saved = data?.data.about ?? "";
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [nat, setNat] = useState("");
  const savedNat = (data?.data.personal?.nationality as string | undefined) ?? "";
  useEffect(() => setText(saved), [saved]);
  // First guess from where they connect from; only prefilled, they confirm by saving.
  useEffect(() => {
    if (!data) return;
    if (savedNat) return setNat(savedNat);
    jp.geo().then((g) => g.nationality && setNat(g.nationality)).catch(() => {});
  }, [data, savedNat]);

  const save = async () => {
    setBusy(true);
    try {
      await jp.patchProfile({ about: text.trim(), personal: { nationality: nat.trim() || undefined } });
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
          <label className="mt-3 block text-[12px] font-medium text-muted-foreground">
            Nationality
            <input
              value={nat}
              onChange={(e) => setNat(e.target.value)}
              placeholder="e.g. Indian"
              className="mt-1 h-9 w-full rounded-xl border border-border bg-background px-3 text-[13.5px] text-foreground outline-none focus:border-primary"
            />
          </label>
          <div className="mt-3">
            <AboutYouField value={text} onChange={setText} />
          </div>
          <div className="mt-2 flex items-center justify-between">
            <span className="text-[11px] text-faint">{text.length}/4000</span>
            <button
              onClick={save}
              disabled={busy || (text.trim() === saved.trim() && nat.trim() === savedNat)}
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
