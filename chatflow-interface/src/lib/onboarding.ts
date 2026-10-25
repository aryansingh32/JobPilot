import { jp, type ProfileDataDTO } from "./api-client";

/** Profile the onboarding answers are stored in (the one jobs are filled from). */
export const ONBOARDING_PROFILE = "default";
/** Marker key written when onboarding is finished or skipped. */
export const ONBOARDED_KEY = "onboardingStatus";

/*
 * The form edits flat string answers; they're stored in the typed profile
 * (/me/profile) via profileToFlat/flatToProfile below.
 */
export interface OnboardingData {
  resumeFileName?: string;
  resumeFileId?: string;
  resumeSource?: "upload" | "manual";
  fullName?: string;
  email?: string;
  mobile?: string;
  mobileVerified?: string;
  city?: string;
  /** ISO country code (from the résumé or the profile) — decides the work-authorization wording. */
  country?: string;
  experienceLevel?: string;
  currentEmployer?: string;
  workAuthorization?: string;
  needsSponsorship?: string;
  targetRoles?: string;
  targetLocations?: string;
  workplace?: string;
  jobTypes?: string;
  expectedSalary?: string;
  noticePeriod?: string;
  photoFileId?: string;
  signatureFileId?: string;
  applicationEmailMode?: "jobpilot-inbox" | "gmail" | "outlook" | "personal";
  notifications?: NotificationPermission | "unsupported";
  smsCodeAutofill?: "supported" | "unsupported";
  reviewBeforeSubmit?: "on" | "off";
  resumeTailoring?: "off" | "honest" | "aggressive";
  [ONBOARDED_KEY]?: "done" | "skipped";
}

type Flat = Record<string, string>;

const list = (v?: string) => (v ? toList(v) : undefined);
const joined = (v?: string[]) => (v?.length ? fromList(v) : undefined);
const yesNo = (v?: boolean) => (v === undefined ? undefined : v ? "yes" : "no");

/** Typed profile (server) → the flat answers the onboarding form edits. */
export function profileToFlat(d: ProfileDataDTO, status?: string): Flat {
  const p = d.personal ?? {};
  const w = d.work ?? {};
  const set = d.settings ?? {};
  const flat: Record<string, string | undefined> = {
    fullName: p.fullName as string | undefined,
    email: p.email as string | undefined,
    mobile: p.phone as string | undefined,
    mobileVerified: p.phoneVerified ? "yes" : undefined,
    city: p.city as string | undefined,
    country: p.country as string | undefined,
    experienceLevel: w.experienceLevel as string | undefined,
    currentEmployer: w.currentEmployer as string | undefined,
    noticePeriod: w.noticePeriod as string | undefined,
    expectedSalary: w.expectedSalary as string | undefined,
    workAuthorization: d.authorization?.statement,
    needsSponsorship: yesNo(d.authorization?.needsSponsorship),
    targetRoles: joined(d.preferences?.roles),
    targetLocations: joined(d.preferences?.locations),
    workplace: joined(d.preferences?.workplace),
    jobTypes: joined(d.preferences?.jobTypes),
    resumeFileId: d.documents?.resumeFileId,
    resumeFileName: d.documents?.resumeFileName,
    resumeSource: d.documents?.resumeFileId ? "upload" : undefined,
    photoFileId: d.documents?.photoFileId,
    signatureFileId: d.documents?.signatureFileId,
    applicationEmailMode: set.applicationEmailMode as string | undefined,
    notifications: set.notifications as string | undefined,
    smsCodeAutofill: set.smsCodeAutofill as string | undefined,
    reviewBeforeSubmit:
      set.reviewBeforeSubmit === undefined ? undefined : set.reviewBeforeSubmit ? "on" : "off",
    resumeTailoring: set.resumeTailoring as string | undefined,
    [ONBOARDED_KEY]: status === "done" || status === "skipped" ? status : undefined,
  };
  return Object.fromEntries(Object.entries(flat).filter(([, v]) => v)) as Flat;
}

/** Flat form answers → a typed profile patch (empty answers are left out). */
export function flatToProfile(f: Flat): ProfileDataDTO {
  const name = f.fullName?.trim();
  return {
    personal: {
      fullName: name,
      firstName: name?.split(/\s+/)[0],
      lastName: name?.split(/\s+/).slice(1).join(" ") || undefined,
      email: f.email,
      phone: f.mobile,
      phoneVerified: f.mobileVerified === "yes" || undefined,
      city: f.city,
    },
    work: {
      experienceLevel: f.experienceLevel,
      currentEmployer: f.currentEmployer,
      noticePeriod: f.noticePeriod,
      expectedSalary: f.expectedSalary,
    },
    authorization: {
      statement: f.workAuthorization,
      needsSponsorship: f.needsSponsorship ? f.needsSponsorship === "yes" : undefined,
      // "Authorized to work in <country>" is what forms' "authorized to work in X?" questions are answered from.
      countries: f.workAuthorization === authorizedIn(f.country) ? [(f.country || "IN").toUpperCase()] : undefined,
    },
    preferences: {
      roles: list(f.targetRoles),
      locations: list(f.targetLocations),
      workplace: list(f.workplace),
      jobTypes: list(f.jobTypes),
    },
    documents: {
      resumeFileId: f.resumeFileId,
      resumeFileName: f.resumeFileName,
      photoFileId: f.photoFileId,
      signatureFileId: f.signatureFileId,
    },
    settings: {
      applicationEmailMode: f.applicationEmailMode,
      notifications: f.notifications,
      smsCodeAutofill: f.smsCodeAutofill,
      reviewBeforeSubmit: f.reviewBeforeSubmit ? f.reviewBeforeSubmit === "on" : undefined,
      resumeTailoring: f.resumeTailoring,
    },
  };
}

export async function loadOnboardingProfile(): Promise<Flat> {
  try {
    const profile = await jp.profile();
    return profileToFlat(profile.data, profile.onboardingStatus);
  } catch {
    return {};
  }
}

/** Partial updates deep-merge on the server, so only answered fields are sent. */
export async function saveOnboardingProfile(data: Flat): Promise<void> {
  const clean = Object.fromEntries(
    Object.entries(data).filter(([, v]) => v !== undefined && v !== null && v !== ""),
  ) as Flat;
  await jp.patchProfile(flatToProfile(clean));
  const status = clean[ONBOARDED_KEY];
  if (status === "done" || status === "skipped") await jp.setOnboarding(status);
}

export function isOnboarded(data: Flat): boolean {
  return data[ONBOARDED_KEY] === "done" || data[ONBOARDED_KEY] === "skipped";
}

/** Upload the resume; the server queues a parse of it (when parsing is on). */
export async function uploadResume(file: Blob, name: string): Promise<{ fileId: string; parseId: string | null }> {
  const { file: saved, parse } = await jp.uploadResume({
    originalName: name,
    mimeType: file.type || "application/octet-stream",
    base64Data: await fileToBase64(file),
  });
  return { fileId: saved.id, parseId: parse?.id ?? null };
}

/**
 * Wait (briefly) for the server to read the resume. Its values only fill gaps
 * in the profile — what the user typed always wins — and the refreshed
 * answers come back for the form. Null if it failed or took too long.
 */
export async function waitForResumePrefill(parseId: string, timeoutMs = 60_000): Promise<Flat | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 1500));
    const { parse } = await jp.latestResumeParse().catch(() => ({ parse: null }));
    if (!parse || parse.id !== parseId) continue;
    if (parse.status === "failed") return null;
    if (parse.status === "done") {
      const profile = await jp.applyResumeParse(parse.id);
      return profileToFlat(profile.data);
    }
  }
  return null;
}

export async function fileToBase64(file: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(",")[1] ?? "");
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

/** Comma-separated profile values <-> chip lists. */
export const toList = (v?: string) =>
  (v ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
export const fromList = (items: string[]) => items.join(", ");

const COUNTRY_NAMES: Record<string, string> = { IN: "India", US: "the United States", GB: "the UK", CA: "Canada" };

/** First work-authorization option, worded for the user's country (India by default). */
export function authorizedIn(country?: string): string {
  return `Authorized to work in ${COUNTRY_NAMES[(country || "IN").toUpperCase()] ?? country}`;
}
