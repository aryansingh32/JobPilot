import { AboutYouField } from "@/components/chat/AboutYouCard";
import { jp } from "@/lib/api-client";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { GmailConnect } from "@/components/chat/GmailConnect";
import { useIntegrations } from "@/lib/live";
import { useEffect, useMemo, useState } from "react";
import {
  ArrowLeft,
  Bell,
  BellOff,
  Check,
  FileText,
  Inbox,
  Loader2,
  Mail,
  MessageSquareText,
  PencilLine,
  ShieldCheck,
  Sparkles,
  Zap,
} from "lucide-react";
import { authClient, type AuthUser } from "@/lib/auth-client";
import { api } from "@/lib/api-client";
import { Brand } from "@/components/chat/ChatSidebar";
import {
  Chips,
  DropZone,
  Field,
  INPUT,
  OptionCard,
  SignaturePad,
  StepHeader,
  TagInput,
} from "@/components/onboarding/ui";
import {
  ONBOARDED_KEY,
  authorizedIn,
  fileToBase64,
  fromList,
  loadOnboardingProfile,
  saveOnboardingProfile,
  toList,
  uploadResume,
  waitForResumePrefill,
  type OnboardingData,
} from "@/lib/onboarding";

export const Route = createFileRoute("/onboarding")({
  head: () => ({ meta: [{ title: "Get started — jobpilot" }] }),
  validateSearch: (s: Record<string, unknown>): { preview?: boolean; gmail?: string } => ({
    ...([true, 1, "1", "true"].includes(s.preview as never) ? { preview: true } : {}),
    // Back from Google's Gmail consent: land on the step that asked for it.
    ...(typeof s.gmail === "string" ? { gmail: s.gmail } : {}),
  }),
  component: Onboarding,
});

type StepId = "resume" | "about" | "prefs" | "docs" | "email" | "apply" | "done";

const STEPS: { id: StepId; label: string; optional?: boolean }[] = [
  { id: "resume", label: "Resume" },
  { id: "about", label: "About you" },
  { id: "prefs", label: "Job preferences" },
  { id: "docs", label: "Photo & signature", optional: true },
  { id: "email", label: "Email & alerts" },
  { id: "apply", label: "How I apply" },
  { id: "done", label: "All set" },
];

type Data = OnboardingData & Record<string, string | undefined>;

function Onboarding() {
  const { preview, gmail: gmailReturn } = Route.useSearch();
  const isPreview = preview && import.meta.env.DEV;
  const navigate = useNavigate();
  const [user, setUser] = useState<AuthUser | null>(null);
  const [ready, setReady] = useState(false);
  const [data, setData] = useState<Data>({});
  const [stepIdx, setStepIdx] = useState(0);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const set = (patch: Partial<Data>) => setData((d) => ({ ...d, ...patch }));
  const step = STEPS[stepIdx];
  // Answers that came from the résumé, so the form can say so.
  const [auto, setAuto] = useState<Set<string>>(() => new Set());
  const draftKey = user ? `jp-onboarding-draft:${user.id}` : null;

  useEffect(() => {
    if (isPreview) {
      setUser({
        id: "preview",
        email: "aryan@example.com",
        emailVerified: true,
        mobileNumber: null,
        mobileVerified: false,
        googleId: null,
        displayName: "Aryan Singh",
      });
      setData({ fullName: "Aryan Singh", email: "aryan@example.com" });
      setReady(true);
      return;
    }
    let cancelled = false;
    (async () => {
      const me = await authClient.me();
      if (cancelled) return;
      if (!me) return navigate({ to: "/login" });
      const existing = await loadOnboardingProfile();
      if (cancelled) return;
      // Progress survives leaving the page (Google's Gmail consent, a refresh, a closed tab).
      let draft: { step?: number; data?: Data; auto?: string[] } = {};
      try {
        draft = JSON.parse(localStorage.getItem(`jp-onboarding-draft:${me.id}`) ?? "{}");
      } catch {
        /* no draft */
      }
      setUser(me);
      setData({
        fullName: me.displayName ?? undefined,
        email: me.email ?? undefined,
        mobile: me.mobileNumber ?? undefined,
        mobileVerified: me.mobileVerified ? "yes" : undefined,
        ...existing,
        ...Object.fromEntries(Object.entries(draft.data ?? {}).filter(([, v]) => v)),
        ...(gmailReturn ? { applicationEmailMode: "gmail" as const } : {}),
      });
      if (draft.auto?.length) setAuto(new Set(draft.auto));
      const emailIdx = STEPS.findIndex((s) => s.id === "email");
      const saved = Math.min(Math.max(draft.step ?? 0, 0), STEPS.length - 1);
      setStepIdx(gmailReturn ? emailIdx : saved);
      setReady(true);
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isPreview, navigate]);

  // Keep the draft current: where the user is, and everything they've entered or we read from the résumé.
  useEffect(() => {
    if (!ready || !draftKey || isPreview) return;
    try {
      localStorage.setItem(draftKey, JSON.stringify({ step: stepIdx, data, auto: [...auto] }));
    } catch {
      /* private mode — the server copy still has everything saved at each Continue */
    }
  }, [ready, draftKey, isPreview, stepIdx, data, auto]);

  const persist = async (patch: Partial<Data> = {}) => {
    const next = { ...data, ...patch };
    setData(next);
    if (isPreview) return;
    await saveOnboardingProfile(next as Record<string, string>);
  };

  const [resumeReading, setResumeReading] = useState(false);
  const [resumeRead, setResumeRead] = useState(false);

  const upload = async (file: Blob, name: string, category: "resume" | "photo" | "signature") => {
    if (isPreview) return `preview-${category}`;
    if (category === "resume") {
      const { fileId, parseId } = await uploadResume(file, name);
      if (parseId) {
        // Reading happens in the background — the user can keep going; whatever
        // they've already typed is kept over the parsed values.
        setResumeReading(true);
        waitForResumePrefill(parseId)
          .then((prefill) => {
            if (!prefill) return;
            setData((prev) => {
              // Only what the user hasn't typed themselves counts as "from the résumé".
              const typed = new Set(
                Object.entries(prev)
                  .filter(([, v]) => v)
                  .map(([k]) => k),
              );
              setAuto(new Set(Object.keys(prefill).filter((k) => !typed.has(k) && prefill[k])));
              return {
                ...prefill,
                ...Object.fromEntries(Object.entries(prev).filter(([, v]) => v)),
              };
            });
            setResumeRead(true);
          })
          .finally(() => setResumeReading(false));
      }
      return fileId;
    }
    const { file: saved } = await api.uploadFile({
      originalName: name,
      mimeType: file.type || "application/octet-stream",
      base64Data: await fileToBase64(file),
      category,
      profileName: "default",
    });
    return saved.id;
  };

  const canContinue = useMemo(() => {
    switch (step.id) {
      case "resume":
        return !!data.resumeSource;
      case "about":
        return !!data.fullName?.trim() && (data.mobile ?? "").replace(/\D/g, "").length >= 10;
      case "prefs":
        return toList(data.targetRoles).length > 0;
      case "email":
        return !!data.applicationEmailMode;
      default:
        return true;
    }
  }, [step.id, data]);

  const next = async () => {
    setError(null);
    setSaving(true);
    try {
      if (step.id === "done") {
        await persist({ [ONBOARDED_KEY]: "done" });
        if (draftKey) localStorage.removeItem(draftKey);
        navigate({ to: "/" });
        return;
      }
      await persist();
      setStepIdx((i) => Math.min(i + 1, STEPS.length - 1));
      document.getElementById("onb-scroll")?.scrollTo({ top: 0 });
    } catch (e) {
      setError((e as Error).message || "Couldn't save — check your connection and try again.");
    } finally {
      setSaving(false);
    }
  };

  // Enter continues, like a form — unless the user is typing in a text area or picking from a list.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Enter" || e.shiftKey || e.isComposing) return;
      const t = e.target as HTMLElement | null;
      if (
        t &&
        (t.tagName === "TEXTAREA" ||
          t.tagName === "SELECT" ||
          t.tagName === "BUTTON" ||
          t.isContentEditable)
      )
        return;
      if (canContinue && !saving) void next();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canContinue, saving, stepIdx, data]);

  const skipAll = async () => {
    try {
      await persist({ [ONBOARDED_KEY]: "skipped" });
      if (draftKey) localStorage.removeItem(draftKey);
    } finally {
      navigate({ to: "/" });
    }
  };

  if (!ready) {
    return (
      <div className="grid h-[100dvh] place-items-center bg-background">
        <Loader2 className="h-5 w-5 animate-spin text-faint" />
      </div>
    );
  }

  const progress = Math.round((stepIdx / (STEPS.length - 1)) * 100);

  return (
    <div className="flex h-[100dvh] bg-background text-foreground">
      {/* Desktop step rail */}
      <aside className="hidden w-[300px] shrink-0 flex-col border-r border-sidebar-border bg-sidebar px-6 py-6 lg:flex">
        <Brand />
        <p className="mt-6 text-[13px] leading-relaxed text-muted-foreground">
          Set up once. jobpilot uses this to fill every application — you approve before anything is
          sent.
        </p>
        <ol className="mt-8 space-y-1">
          {STEPS.map((s, i) => {
            const done = i < stepIdx;
            const active = i === stepIdx;
            return (
              <li key={s.id}>
                <button
                  disabled={i > stepIdx}
                  onClick={() => setStepIdx(i)}
                  className={`flex w-full items-center gap-3 rounded-xl px-2.5 py-2 text-left text-[14px] transition-colors ${
                    active
                      ? "bg-sidebar-accent font-semibold text-foreground"
                      : done
                        ? "text-ink-2 hover:bg-sidebar-accent/60"
                        : "text-faint"
                  }`}
                >
                  <span
                    className={`grid h-6 w-6 shrink-0 place-items-center rounded-full text-[11px] font-bold ${
                      done
                        ? "bg-primary text-primary-foreground"
                        : active
                          ? "border-2 border-primary text-primary"
                          : "border border-border text-faint"
                    }`}
                  >
                    {done ? <Check className="h-3.5 w-3.5" strokeWidth={3} /> : i + 1}
                  </span>
                  <span className="flex-1">{s.label}</span>
                  {s.optional && !done && <span className="text-[11px] text-faint">Optional</span>}
                </button>
              </li>
            );
          })}
        </ol>
        <div className="mt-auto flex items-center gap-2 rounded-xl bg-muted px-3 py-2.5 text-[12px] text-muted-foreground">
          <ShieldCheck className="h-4 w-4 shrink-0 text-success" />
          Your details stay private to your account and are only used for your applications.
        </div>
      </aside>

      <main className="flex min-w-0 flex-1 flex-col">
        {/* Top bar */}
        <header className="flex h-14 shrink-0 items-center gap-3 px-4 sm:px-6">
          <div className="lg:hidden">
            <Brand compact />
          </div>
          <div className="min-w-0 flex-1 lg:hidden">
            <div className="text-[12px] font-medium text-muted-foreground">
              Step {stepIdx + 1} of {STEPS.length} · {step.label}
            </div>
          </div>
          <div className="hidden flex-1 lg:block" />
          {step.id !== "done" && (
            <button
              onClick={skipAll}
              className="shrink-0 text-[13px] font-medium text-muted-foreground hover:text-foreground"
            >
              Skip for now
            </button>
          )}
        </header>
        <div className="h-1 bg-muted lg:hidden">
          <div
            className="h-full bg-primary transition-[width] duration-500"
            style={{ width: `${progress}%` }}
          />
        </div>

        <div
          id="onb-scroll"
          className="scroll-thin flex-1 overflow-y-auto px-4 pb-8 pt-6 sm:px-6 sm:pt-10"
        >
          <div
            key={step.id}
            className="mx-auto w-full max-w-[34rem] animate-in fade-in-0 slide-in-from-bottom-2 duration-300"
          >
            {step.id === "resume" && (
              <ResumeStep
                data={data}
                set={set}
                auto={auto}
                upload={upload}
                reading={resumeReading}
                read={resumeRead}
              />
            )}
            {step.id === "about" && (
              <AboutStep data={data} set={set} auto={auto} user={user} isPreview={!!isPreview} />
            )}
            {step.id === "prefs" && <PrefsStep data={data} set={set} auto={auto} />}
            {step.id === "docs" && <DocsStep data={data} set={set} upload={upload} />}
            {step.id === "email" && (
              <>
                <EmailStep data={data} set={set} />
                <div className="mt-8 border-t border-border pt-6">
                  <PermissionsStep data={data} set={set} />
                </div>
              </>
            )}
            {step.id === "apply" && <ApplyStep data={data} set={set} />}
            {step.id === "done" && <DoneStep data={data} />}
          </div>
        </div>

        {/* Bottom actions — sticky on phones */}
        <footer className="shrink-0 border-t border-border bg-background/95 px-4 py-3 backdrop-blur sm:px-6">
          <div className="mx-auto flex w-full max-w-[34rem] items-center gap-2">
            {stepIdx > 0 && step.id !== "done" && (
              <button
                onClick={() => setStepIdx((i) => i - 1)}
                className="grid h-11 w-11 shrink-0 place-items-center rounded-full border border-border text-ink-2 hover:border-faint"
                aria-label="Back"
              >
                <ArrowLeft className="h-4 w-4" />
              </button>
            )}
            {error && (
              <span className="min-w-0 flex-1 truncate text-[12px] text-destructive">{error}</span>
            )}
            {!error && (
              <span className="flex-1 truncate text-[12px] text-faint">
                {step.id === "done" ? "" : `${timeLeft(STEPS.length - 1 - stepIdx)}`}
              </span>
            )}
            {step.optional && (
              <button
                onClick={() => setStepIdx((i) => i + 1)}
                className="h-11 shrink-0 rounded-full px-4 text-[14px] font-medium text-muted-foreground hover:text-foreground"
              >
                Skip
              </button>
            )}
            <button
              onClick={next}
              disabled={!canContinue || saving}
              className="flex h-11 shrink-0 items-center gap-2 rounded-full bg-primary px-6 text-[14px] font-semibold text-primary-foreground transition-all hover:opacity-90 active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-40"
            >
              {saving && <Loader2 className="h-4 w-4 animate-spin" />}
              {step.id === "done" ? "Start applying" : "Continue"}
            </button>
          </div>
        </footer>
      </main>
    </div>
  );
}

/* ─────────────────────────── Steps ─────────────────────────── */

type StepProps = { data: Data; set: (p: Partial<Data>) => void; auto: Set<string> };
type Uploader = (
  file: Blob,
  name: string,
  category: "resume" | "photo" | "signature",
) => Promise<string>;

function ResumeStep({
  data,
  set,
  upload,
  reading,
  read,
  auto,
}: StepProps & { upload: Uploader; reading: boolean; read: boolean }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  return (
    <>
      <StepHeader
        eyebrow="Step 1 · Resume"
        title="Start with your resume"
        sub="I'll use it to fill applications and pick jobs that fit. You can edit everything later."
      />
      <DropZone
        accept=".pdf,.doc,.docx"
        title="Upload your resume"
        hint="PDF or Word · up to 10 MB · drag & drop or tap"
        fileName={data.resumeSource === "upload" ? data.resumeFileName : undefined}
        busy={busy}
        onFile={async (f) => {
          if (f.size > 10 * 1024 * 1024) return setErr("That file is over 10 MB.");
          setErr(null);
          setBusy(true);
          try {
            const id = await upload(f, f.name, "resume");
            set({ resumeSource: "upload", resumeFileName: f.name, resumeFileId: id });
          } catch (e) {
            setErr((e as Error).message || "Upload failed — try again.");
          } finally {
            setBusy(false);
          }
        }}
      />
      {err && <p className="mt-2 text-[12px] text-destructive">{err}</p>}
      {reading && !err && (
        <div className="mt-3 flex items-start gap-3 rounded-[16px] border border-primary-border bg-primary-soft/50 p-4 animate-in fade-in-0">
          <Loader2 className="mt-0.5 h-4 w-4 shrink-0 animate-spin text-primary" />
          <div className="min-w-0 text-[13px]">
            <div className="font-semibold text-foreground">Reading your resume…</div>
            <p className="mt-0.5 text-muted-foreground">
              Pulling out your name, contact details, experience and the roles you fit, so the next
              steps are already filled in. You can continue meanwhile.
            </p>
          </div>
        </div>
      )}
      {read && !reading && !err && (
        <div className="mt-3 rounded-[16px] border border-border bg-card p-4 animate-in fade-in-0">
          <div className="flex items-center gap-1.5 text-[13px] font-semibold text-foreground">
            <Check className="h-4 w-4 text-success" /> Got it — here's what I found
          </div>
          <div className="mt-2 flex flex-wrap gap-1.5">
            {(
              [
                ["fullName", "Name"],
                ["email", "Email"],
                ["mobile", "Phone"],
                ["city", "City"],
                ["experienceLevel", "Experience"],
                ["currentEmployer", "Employer"],
                ["targetRoles", "Roles"],
                ["targetLocations", "Locations"],
              ] as const
            )
              .filter(([k]) => auto.has(k))
              .map(([k, label]) => (
                <span
                  key={k}
                  className="rounded-full bg-primary-soft px-2.5 py-0.5 text-[12px] font-semibold text-primary-soft-foreground"
                >
                  {label}
                </span>
              ))}
          </div>
          <p className="mt-2 text-[12px] text-muted-foreground">
            I've filled these in on the next steps — check them and change anything that's off.
          </p>
        </div>
      )}
      <div className="my-5 flex items-center gap-3 text-[12px] text-faint">
        <span className="h-px flex-1 bg-border" /> or <span className="h-px flex-1 bg-border" />
      </div>
      <OptionCard
        selected={data.resumeSource === "manual"}
        onClick={() => set({ resumeSource: "manual" })}
        icon={<PencilLine className="h-5 w-5" />}
        title="I'll fill in my details instead"
        description="No resume handy? Answer a few questions now and add a resume any time from your profile."
      />
    </>
  );
}

function AboutStep({
  data,
  set,
  auto,
  user,
  isPreview,
}: StepProps & { user: AuthUser | null; isPreview: boolean }) {
  const signedInWithMobile = !!user?.mobileNumber && user.mobileVerified;
  const [code, setCode] = useState("");
  const [otpState, setOtpState] = useState<"idle" | "sending" | "sent" | "verifying">("idle");
  const [err, setErr] = useState<string | null>(null);
  const verified = data.mobileVerified === "yes";

  const sendCode = async () => {
    setErr(null);
    setOtpState("sending");
    try {
      if (!isPreview) await authClient.requestMobileOtp(normalizeMobile(data.mobile));
      setOtpState("sent");
    } catch (e) {
      setErr((e as Error).message);
      setOtpState("idle");
    }
  };
  const verify = async () => {
    setErr(null);
    setOtpState("verifying");
    try {
      if (!isPreview) await authClient.linkMobile(normalizeMobile(data.mobile), code);
      set({ mobileVerified: "yes" });
      setOtpState("idle");
    } catch (e) {
      setErr((e as Error).message);
      setOtpState("sent");
    }
  };

  return (
    <>
      <StepHeader
        eyebrow="Step 2 · About you"
        title="The basics every form asks for"
        sub="Filled once, reused on every application."
      />
      <div className="space-y-4">
        <Field auto={auto.has("fullName")} label="Full name">
          <input
            className={INPUT}
            value={data.fullName ?? ""}
            onChange={(e) => set({ fullName: e.target.value })}
            autoComplete="name"
          />
        </Field>
        <Field
          auto={auto.has("email") && !user?.email}
          label="Email"
          hint={user?.email ? "From your sign-in" : undefined}
        >
          <input
            className={`${INPUT} ${user?.email ? "bg-muted text-ink-2" : ""}`}
            value={data.email ?? ""}
            readOnly={!!user?.email}
            onChange={(e) => set({ email: e.target.value })}
            type="email"
            inputMode="email"
            autoComplete="email"
          />
        </Field>
        <Field
          group
          auto={auto.has("mobile")}
          label="Mobile number"
          hint={
            signedInWithMobile
              ? "Verified at sign-in"
              : "Most job sites require it, and some send codes to it. Verify it so I can use it."
          }
        >
          <div className="flex gap-2">
            <input
              className={`${INPUT} ${signedInWithMobile ? "bg-muted text-ink-2" : ""}`}
              value={data.mobile ?? ""}
              readOnly={signedInWithMobile}
              onChange={(e) => set({ mobile: e.target.value, mobileVerified: undefined })}
              type="tel"
              inputMode="tel"
              autoComplete="tel"
              placeholder="+91 98765 43210"
            />
            {!signedInWithMobile &&
              (verified ? (
                <span className="flex h-11 shrink-0 items-center gap-1 rounded-full bg-primary-soft px-3.5 text-[13px] font-semibold text-primary-soft-foreground">
                  <Check className="h-4 w-4" /> Verified
                </span>
              ) : (
                <button
                  type="button"
                  onClick={sendCode}
                  disabled={
                    (data.mobile ?? "").replace(/\D/g, "").length < 10 || otpState === "sending"
                  }
                  className="h-11 shrink-0 rounded-full border border-border px-4 text-[13px] font-semibold text-ink-2 hover:border-faint disabled:opacity-40"
                >
                  {otpState === "sending" ? "Sending…" : otpState === "sent" ? "Resend" : "Verify"}
                </button>
              ))}
          </div>
          {(otpState === "sent" || otpState === "verifying") && !verified && (
            <div className="mt-2 flex gap-2">
              <input
                className={`${INPUT} tracking-[0.3em] placeholder:tracking-normal`}
                value={code}
                onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
                inputMode="numeric"
                autoComplete="one-time-code"
                placeholder="6-digit code"
                autoFocus
              />
              <button
                type="button"
                onClick={verify}
                disabled={code.length < 4 || otpState === "verifying"}
                className="h-11 shrink-0 rounded-full bg-primary px-5 text-[13px] font-semibold text-primary-foreground disabled:opacity-40"
              >
                {otpState === "verifying" ? "Checking…" : "Confirm"}
              </button>
            </div>
          )}
          {err && <span className="mt-1 block text-[12px] text-destructive">{err}</span>}
        </Field>
        <Field auto={auto.has("city")} label="City">
          <input
            className={INPUT}
            value={data.city ?? ""}
            onChange={(e) => set({ city: e.target.value })}
            autoComplete="address-level2"
            placeholder="e.g. Lucknow"
          />
        </Field>
        <Field group auto={auto.has("experienceLevel")} label="Experience">
          <Chips
            options={["Student / fresher", "0–2 years", "2–5 years", "5–10 years", "10+ years"]}
            value={data.experienceLevel ? [data.experienceLevel] : []}
            onChange={([v]) => set({ experienceLevel: v })}
          />
        </Field>
        <Field auto={auto.has("currentEmployer")} label="Current or last employer" optional>
          <input
            className={INPUT}
            value={data.currentEmployer ?? ""}
            onChange={(e) => set({ currentEmployer: e.target.value })}
            autoComplete="organization"
          />
        </Field>
        <Field group label="Work authorization">
          <Chips
            options={[
              authorizedIn(data.country),
              "Need visa sponsorship",
              "Authorized in multiple countries",
            ]}
            value={data.workAuthorization ? [data.workAuthorization] : []}
            onChange={([v]) =>
              set({
                workAuthorization: v,
                needsSponsorship: v === "Need visa sponsorship" ? "yes" : "no",
              })
            }
          />
        </Field>
        <Field label="Nationality">
          <NationalityBox value={data.nationality ?? ""} onChange={(v) => set({ nationality: v })} />
        </Field>
        <Field label="Tell us more about you (optional)">
          <p className="mb-2 text-[12px] text-muted-foreground">
            Passing-out year, CGPA, relocation, anything employers ask — I answer from this so I rarely need to stop and ask.
          </p>
          <AboutYouField value={data.about ?? ""} onChange={(v) => set({ about: v })} />
        </Field>
      </div>
    </>
  );
}

function PrefsStep({ data, set, auto }: StepProps) {
  return (
    <>
      <StepHeader
        eyebrow="Step 3 · Job preferences"
        title="What are you looking for?"
        sub="This shapes your matches. Add as many roles as you like."
      />
      <div className="space-y-5">
        <Field group auto={auto.has("targetRoles")} label="Roles">
          <TagInput
            value={toList(data.targetRoles)}
            onChange={(v) => set({ targetRoles: fromList(v) })}
            suggestions={[
              "Software Engineer",
              "Full Stack Developer",
              "Frontend Developer",
              "Backend Developer",
              "Data Analyst",
              "Product Manager",
              "Mobile Developer",
              "QA Engineer",
            ]}
            placeholder="Type a role and press Enter"
          />
        </Field>
        <Field group auto={auto.has("targetLocations")} label="Locations">
          <TagInput
            value={toList(data.targetLocations)}
            onChange={(v) => set({ targetLocations: fromList(v) })}
            suggestions={[
              "Bengaluru",
              "Hyderabad",
              "Pune",
              "Delhi NCR",
              "Mumbai",
              "Chennai",
              "Remote",
            ]}
            placeholder="Cities you'd work in"
          />
        </Field>
        <Field group label="Workplace">
          <Chips
            multi
            options={["Remote", "Hybrid", "On-site"]}
            value={toList(data.workplace)}
            onChange={(v) => set({ workplace: fromList(v) })}
          />
        </Field>
        <Field group label="Job type">
          <Chips
            multi
            options={["Full-time", "Internship", "Contract", "Part-time"]}
            value={toList(data.jobTypes)}
            onChange={(v) => set({ jobTypes: fromList(v) })}
          />
        </Field>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field
            label="Expected salary"
            optional
            hint="Used only when a form asks — never guessed."
          >
            <input
              className={INPUT}
              value={data.expectedSalary ?? ""}
              onChange={(e) => set({ expectedSalary: e.target.value })}
              placeholder="e.g. 6 LPA"
            />
          </Field>
          <Field label="Notice period">
            <select
              className={INPUT}
              value={data.noticePeriod ?? ""}
              onChange={(e) => set({ noticePeriod: e.target.value })}
            >
              <option value="">Select</option>
              <option>Immediately</option>
              <option>15 days</option>
              <option>30 days</option>
              <option>60 days</option>
              <option>90 days</option>
            </select>
          </Field>
        </div>
      </div>
    </>
  );
}

function DocsStep({ data, set, upload }: Pick<StepProps, "data" | "set"> & { upload: Uploader }) {
  const [photoPreview, setPhotoPreview] = useState<string | null>(null);
  const [busy, setBusy] = useState<"photo" | "signature" | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [sigMode, setSigMode] = useState<"draw" | "upload">("draw");
  const [sigBlob, setSigBlob] = useState<Blob | null>(null);

  const save = async (blob: Blob, name: string, kind: "photo" | "signature") => {
    setErr(null);
    setBusy(kind);
    try {
      const id = await upload(blob, name, kind);
      set(kind === "photo" ? { photoFileId: id } : { signatureFileId: id });
    } catch (e) {
      setErr((e as Error).message || "Upload failed — try again.");
    } finally {
      setBusy(null);
    }
  };

  return (
    <>
      <StepHeader
        eyebrow="Step 4 · Photo & signature"
        title="For forms that ask for them"
        sub="Many applications want a passport-style photo, and some want a signature. Add them once — both optional."
      />
      <div className="space-y-6">
        <Field
          group
          label="Photo"
          optional
          hint="Plain background, face clearly visible. JPG or PNG."
        >
          <div className="flex items-center gap-4">
            <span className="grid h-20 w-20 shrink-0 place-items-center overflow-hidden rounded-2xl border border-border bg-muted text-faint">
              {photoPreview ? (
                <img src={photoPreview} alt="Your photo" className="h-full w-full object-cover" />
              ) : data.photoFileId ? (
                <Check className="h-6 w-6 text-success" />
              ) : (
                <span className="text-[11px]">No photo</span>
              )}
            </span>
            <div className="min-w-0 flex-1">
              <DropZone
                accept="image/*"
                capture="user"
                title={busy === "photo" ? "Uploading…" : "Upload or take a photo"}
                hint="Opens your camera on phones"
                busy={busy === "photo"}
                fileName={data.photoFileId ? "Photo added" : undefined}
                onFile={(f) => {
                  setPhotoPreview(URL.createObjectURL(f));
                  void save(f, f.name, "photo");
                }}
              />
            </div>
          </div>
        </Field>

        <Field group label="Signature" optional>
          <div className="mb-2 flex w-fit rounded-full bg-muted p-1">
            {(["draw", "upload"] as const).map((m) => (
              <button
                key={m}
                type="button"
                onClick={() => setSigMode(m)}
                className={`rounded-full px-3.5 py-1.5 text-[12px] font-semibold ${
                  sigMode === m ? "bg-card text-foreground shadow-sm" : "text-muted-foreground"
                }`}
              >
                {m === "draw" ? "Draw" : "Upload image"}
              </button>
            ))}
          </div>
          {sigMode === "draw" ? (
            <>
              <SignaturePad onChange={setSigBlob} />
              <button
                type="button"
                disabled={!sigBlob || busy === "signature"}
                onClick={() => sigBlob && save(sigBlob, "signature.png", "signature")}
                className="mt-2 h-10 rounded-full border border-border px-4 text-[13px] font-semibold text-ink-2 hover:border-faint disabled:opacity-40"
              >
                {busy === "signature"
                  ? "Saving…"
                  : data.signatureFileId
                    ? "Signature saved ✓ · Save again"
                    : "Save signature"}
              </button>
            </>
          ) : (
            <DropZone
              accept="image/*"
              title="Upload a photo of your signature"
              hint="Black ink on white paper works best"
              busy={busy === "signature"}
              fileName={data.signatureFileId ? "Signature added" : undefined}
              onFile={(f) => save(f, f.name, "signature")}
            />
          )}
        </Field>
        {err && <p className="text-[12px] text-destructive">{err}</p>}
      </div>
    </>
  );
}

function EmailStep({ data, set }: Pick<StepProps, "data" | "set">) {
  const gmailAvailable = !!useIntegrations().data?.gmail.available;
  return (
    <>
      <StepHeader
        eyebrow="Step 5 · Email & alerts"
        title="Where should employers reach you?"
        sub="Sites send codes, confirmations and replies here. I read them to finish applications and keep your Inbox up to date."
      />
      <div className="space-y-3">
        <OptionCard
          selected={data.applicationEmailMode === "jobpilot-inbox"}
          onClick={() => set({ applicationEmailMode: "jobpilot-inbox" })}
          icon={<Inbox className="h-5 w-5" />}
          title="A private jobpilot inbox"
          badge="Recommended"
          description="A dedicated address just for applications. Codes are read in automatically, replies forward to your email, and your personal inbox stays clean. Until it's live, I'll use your own email."
        />
        <OptionCard
          selected={data.applicationEmailMode === "personal"}
          onClick={() => set({ applicationEmailMode: "personal" })}
          icon={<Mail className="h-5 w-5" />}
          title={`Use ${data.email || "my own email"}`}
          description="Apply with your own address. You'll forward or paste codes when a site sends one."
        />
        <OptionCard
          selected={data.applicationEmailMode === "gmail"}
          onClick={() => set({ applicationEmailMode: "gmail" })}
          icon={<span className="text-[15px] font-bold">G</span>}
          title="Connect Gmail"
          badge={gmailAvailable ? undefined : "Coming soon"}
          disabled={!gmailAvailable}
          description="Read only job-related emails to fill codes and track replies. Never sends mail on its own."
        />
        {data.applicationEmailMode === "gmail" && gmailAvailable && <GmailConnect compact />}
        <OptionCard
          selected={data.applicationEmailMode === "outlook"}
          onClick={() => set({ applicationEmailMode: "outlook" })}
          icon={<span className="text-[15px] font-bold">O</span>}
          title="Connect Outlook"
          badge="Coming soon"
          disabled
          description="Same as Gmail, for Outlook.com and Microsoft 365."
        />
      </div>
    </>
  );
}

function PermissionsStep({ data, set }: Pick<StepProps, "data" | "set">) {
  const notifSupported = typeof window !== "undefined" && "Notification" in window;
  // The WebOTP API exists in desktop Chrome too, but only phones receive SMS.
  const smsSupported =
    typeof window !== "undefined" &&
    "OTPCredential" in window &&
    /Android/i.test(navigator.userAgent);
  const notif = data.notifications ?? (notifSupported ? Notification.permission : "unsupported");

  useEffect(() => {
    set({ smsCodeAutofill: smsSupported ? "supported" : "unsupported" });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <>
      <StepHeader
        eyebrow="Alerts"
        title="Know the moment I need you"
        sub="Applications sometimes pause for a code or your approval. These keep things moving without you watching."
      />
      <div className="space-y-3">
        <div className="flex items-start gap-3 rounded-[16px] border border-border bg-card p-4">
          <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-muted text-ink-2">
            {notif === "granted" ? (
              <Bell className="h-5 w-5 text-success" />
            ) : notif === "denied" ? (
              <BellOff className="h-5 w-5" />
            ) : (
              <Bell className="h-5 w-5" />
            )}
          </span>
          <div className="min-w-0 flex-1">
            <div className="text-[14px] font-semibold text-foreground">Notifications</div>
            <p className="mt-0.5 text-[13px] text-muted-foreground">
              {notif === "granted"
                ? "On — I'll notify you when an application needs you or is submitted."
                : notif === "denied"
                  ? "Blocked in your browser. You can turn it on from the site settings (lock icon in the address bar)."
                  : notif === "unsupported"
                    ? "This browser doesn't support notifications. You'll still see everything in Tasks."
                    : "Get a ping when an application needs a code or your approval, and when it's submitted."}
            </p>
          </div>
          {notif === "default" && (
            <button
              type="button"
              onClick={async () => set({ notifications: await Notification.requestPermission() })}
              className="h-10 shrink-0 rounded-full bg-primary px-4 text-[13px] font-semibold text-primary-foreground"
            >
              Allow
            </button>
          )}
        </div>

        <div className="flex items-start gap-3 rounded-[16px] border border-border bg-card p-4">
          <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-muted text-ink-2">
            <MessageSquareText className="h-5 w-5" />
          </span>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-[14px] font-semibold text-foreground">Fill codes from SMS</span>
              <span
                className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${
                  smsSupported
                    ? "bg-primary-soft text-primary-soft-foreground"
                    : "bg-muted text-muted-foreground"
                }`}
              >
                {smsSupported ? "Supported on this device" : "Not on this device"}
              </span>
            </div>
            <p className="mt-0.5 text-[13px] text-muted-foreground">
              {smsSupported
                ? "When a site texts you a code, your phone offers to fill it with one tap — no copying."
                : "On Android Chrome your phone can offer SMS codes in one tap. Here, you'll type or paste the code — I'll point you right to it."}
            </p>
          </div>
        </div>

        <div className="flex items-start gap-3 rounded-[16px] border border-border bg-card p-4">
          <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-muted text-ink-2">
            <Mail className="h-5 w-5" />
          </span>
          <div className="min-w-0 flex-1">
            <div className="text-[14px] font-semibold text-foreground">Codes from email</div>
            <p className="mt-0.5 text-[13px] text-muted-foreground">
              {data.applicationEmailMode === "jobpilot-inbox"
                ? "Handled by your jobpilot inbox — codes are read in automatically once it's live."
                : "Codes sent to your own email show up as a quick card for you to paste."}
            </p>
          </div>
        </div>
      </div>
    </>
  );
}

function ApplyStep({ data, set }: Pick<StepProps, "data" | "set">) {
  const review = data.reviewBeforeSubmit ?? "on";
  const tailoring = data.resumeTailoring ?? "honest";
  useEffect(() => {
    if (!data.reviewBeforeSubmit || !data.resumeTailoring)
      set({ reviewBeforeSubmit: review, resumeTailoring: tailoring });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return (
    <>
      <StepHeader
        eyebrow="Step 6 · How I apply"
        title="You stay in control"
        sub="Change these any time in Settings."
      />
      <div className="space-y-6">
        <div className="space-y-3">
          <div className="text-[13px] font-semibold text-foreground">Before submitting</div>
          <OptionCard
            selected={review === "on"}
            onClick={() => set({ reviewBeforeSubmit: "on" })}
            icon={<ShieldCheck className="h-5 w-5" />}
            title="Show me every application first"
            badge="Recommended"
            description="I fill the form and pause. You check the answers, edit anything, then approve. Exactly what you approve is sent."
          />
          <OptionCard
            selected={review === "off"}
            onClick={() => set({ reviewBeforeSubmit: "off" })}
            icon={<Zap className="h-5 w-5" />}
            title="Submit automatically"
            description="Faster. I still stop and ask whenever an answer isn't in your profile — I never guess salary, IDs or legal questions."
          />
        </div>
        <div>
          <div className="mb-2 text-[13px] font-semibold text-foreground">Resume for each job</div>
          <div className="grid grid-cols-3 gap-2">
            {(
              [
                ["off", "As is", "Send your resume unchanged"],
                ["honest", "Honest", "Reorder & highlight what fits — nothing invented"],
                ["aggressive", "Bold", "Stronger wording, still only real experience"],
              ] as const
            ).map(([v, t, d]) => (
              <button
                key={v}
                type="button"
                onClick={() => set({ resumeTailoring: v })}
                className={`rounded-[14px] border p-3 text-left transition-colors ${
                  tailoring === v
                    ? "border-primary bg-primary-soft/60 ring-1 ring-primary"
                    : "border-border bg-card hover:border-faint"
                }`}
              >
                <div className="text-[13px] font-semibold text-foreground">{t}</div>
                <div className="mt-0.5 text-[11px] leading-snug text-muted-foreground">{d}</div>
              </button>
            ))}
          </div>
        </div>
      </div>
    </>
  );
}

function DoneStep({ data }: { data: Data }) {
  const rows: [string, string | undefined][] = [
    [
      "Resume",
      data.resumeSource === "upload"
        ? data.resumeFileName
        : data.resumeSource === "manual"
          ? "Filled in manually"
          : undefined,
    ],
    [
      "Mobile",
      data.mobile
        ? `${data.mobile}${data.mobileVerified === "yes" ? " · verified" : ""}`
        : undefined,
    ],
    ["Roles", data.targetRoles],
    ["Locations", data.targetLocations],
    [
      "Photo & signature",
      [data.photoFileId && "Photo", data.signatureFileId && "Signature"]
        .filter(Boolean)
        .join(" + ") || undefined,
    ],
    [
      "Application email",
      (
        {
          "jobpilot-inbox": "jobpilot inbox",
          personal: data.email,
          gmail: "Gmail",
          outlook: "Outlook",
        } as Record<string, string | undefined>
      )[data.applicationEmailMode ?? ""],
    ],
    [
      "Before submitting",
      data.reviewBeforeSubmit === "off" ? "Submit automatically" : "Review first",
    ],
  ];
  return (
    <>
      <div className="mb-6 flex flex-col items-center text-center">
        <span className="mb-4 grid h-14 w-14 place-items-center rounded-full bg-primary text-primary-foreground">
          <Sparkles className="h-6 w-6" />
        </span>
        <h1 className="text-[26px] font-bold tracking-tight text-foreground">
          You're all set{data.fullName ? `, ${data.fullName.split(" ")[0]}` : ""}
        </h1>
        <p className="mt-1.5 max-w-sm text-[14px] text-muted-foreground">
          Pick a job or paste any link — I'll fill the form, you approve, and you get a receipt for
          every application.
        </p>
      </div>
      <dl className="divide-y divide-border overflow-hidden rounded-[18px] border border-border bg-card">
        {rows.map(([k, v]) => (
          <div key={k} className="flex gap-3 px-4 py-3 text-[13px]">
            <dt className="w-[42%] shrink-0 text-muted-foreground">{k}</dt>
            <dd
              className={`min-w-0 flex-1 break-words ${v ? "font-medium text-foreground" : "text-faint"}`}
            >
              {v ? (
                <span className="flex items-start gap-1.5">
                  <Check className="mt-0.5 h-3.5 w-3.5 shrink-0 text-success" /> {v}
                </span>
              ) : (
                "Not added — you can add it later"
              )}
            </dd>
          </div>
        ))}
      </dl>
      <p className="mt-4 flex items-center justify-center gap-1.5 text-[12px] text-faint">
        <FileText className="h-3.5 w-3.5" /> Everything here is editable from your profile.
      </p>
    </>
  );
}

/** Rough time left at ~15 seconds a step, said the way a person would. */
function timeLeft(stepsLeft: number): string {
  const sec = stepsLeft * 15;
  return sec < 60 ? "Under a minute left" : `About ${Math.round(sec / 60)} min left`;
}

function normalizeMobile(v?: string): string {
  const digits = (v ?? "").replace(/[^\d+]/g, "");
  return digits.startsWith("+") ? digits : digits.length === 10 ? `+91${digits}` : digits;
}

/** Nationality, guessed from where the person connects from; they can change it. */
function NationalityBox({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  useEffect(() => {
    if (value) return;
    jp.geo().then((g) => g.nationality && onChange(g.nationality)).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return (
    <input
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder="e.g. Indian"
      className="h-11 w-full rounded-xl border border-border bg-background px-3 text-[14px] text-foreground outline-none focus:border-primary"
    />
  );
}
