import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  ArrowLeft,
  Check,
  Copy,
  ExternalLink,
  Inbox,
  KeyRound,
  Link2,
  Loader2,
  MailCheck,
  MailOpen,
  MessageSquareReply,
  Search,
} from "lucide-react";
import { jp, type InboxEmailDTO } from "@/lib/api-client";
import { ts, useInboxActions } from "@/lib/live";
import { GmailConnect } from "./GmailConnect";

type InboxEmail = InboxEmailDTO;
type Filter = "all" | "unread" | InboxEmail["category"];

const FILTERS: { id: Filter; label: string }[] = [
  { id: "all", label: "All" },
  { id: "unread", label: "Unread" },
  { id: "code", label: "Codes" },
  { id: "confirmation", label: "Confirmations" },
  { id: "reply", label: "Replies" },
];

const CATEGORY: Record<
  InboxEmail["category"],
  { label: string; className: string; icon: typeof Inbox }
> = {
  code: {
    label: "Code",
    className: "bg-warning-soft text-warning-soft-foreground",
    icon: KeyRound,
  },
  confirmation: {
    label: "Confirmation",
    className: "bg-primary-soft text-primary-soft-foreground",
    icon: MailCheck,
  },
  reply: { label: "Reply", className: "bg-muted text-ink-2", icon: MessageSquareReply },
  other: { label: "Email", className: "bg-muted text-muted-foreground", icon: Inbox },
};

const INTENT: Record<string, { label: string; className: string }> = {
  interview: { label: "Interview", className: "bg-success/15 text-success" },
  assessment: { label: "Assessment", className: "bg-primary-soft text-primary-soft-foreground" },
  offer: { label: "Offer", className: "bg-success/15 text-success" },
  rejection: { label: "Not moving forward", className: "bg-destructive/10 text-destructive" },
};

/**
 * Mail jobpilot reads for you: sign-in codes, verification links, confirmations
 * and employer replies. A list on the left, the whole message on the right
 * (on a phone: tap one, read it full-screen, back arrow returns).
 */
export function InboxView({
  emails,
  address,
  loading,
  onOpenApplication,
}: {
  emails: InboxEmail[];
  address: string | null;
  loading: boolean;
  onOpenApplication: (applicationId: string) => void;
}) {
  const { markRead } = useInboxActions();
  const [filter, setFilter] = useState<Filter>("all");
  const [query, setQuery] = useState("");
  const [openId, setOpenId] = useState<string | null>(null);
  const [copiedAddress, setCopiedAddress] = useState(false);

  const sorted = [...emails].sort((a, b) => ts(b.received_at) - ts(a.received_at));
  const q = query.trim().toLowerCase();
  const visible = sorted.filter(
    (e) =>
      (filter === "all" || (filter === "unread" ? !e.read : e.category === filter)) &&
      (!q ||
        `${e.subject} ${e.from_name ?? ""} ${e.from_address} ${e.snippet}`
          .toLowerCase()
          .includes(q)),
  );
  const unread = emails.filter((e) => !e.read).length;
  const open = emails.find((e) => e.id === openId) ?? null;

  // On a wide screen the reader is always showing something: the newest message to start with.
  useEffect(() => {
    if (
      !openId &&
      visible.length &&
      typeof window !== "undefined" &&
      window.matchMedia("(min-width: 768px)").matches
    ) {
      select(visible[0]);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible.length, filter]);

  function select(e: InboxEmail) {
    setOpenId(e.id);
    if (!e.read) markRead.mutate({ id: e.id, read: true });
  }

  const list = (
    <div className="flex min-h-0 min-w-0 flex-col">
      <label className="mb-2 flex h-10 items-center gap-2 rounded-full border border-border bg-card px-3.5 focus-within:border-primary">
        <Search className="h-4 w-4 shrink-0 text-faint" />
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search messages"
          className="min-w-0 flex-1 bg-transparent text-[14px] outline-none placeholder:text-faint"
        />
      </label>
      <div className="mb-3 flex flex-wrap gap-1.5">
        {FILTERS.map((f) => {
          const n =
            f.id === "all"
              ? emails.length
              : f.id === "unread"
                ? unread
                : emails.filter((e) => e.category === f.id).length;
          const active = filter === f.id;
          return (
            <button
              key={f.id}
              onClick={() => setFilter(f.id)}
              className={`flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full border px-3 py-1 text-[12.5px] font-medium transition-colors ${
                active
                  ? "border-foreground bg-foreground text-background"
                  : "border-border bg-card text-ink-2 hover:border-faint"
              }`}
            >
              {f.label}
              <span className={active ? "opacity-70" : "text-faint"}>{n}</span>
            </button>
          );
        })}
      </div>

      {loading ? (
        <div className="overflow-hidden rounded-[18px] border border-border bg-card">
          {[0, 1, 2, 3].map((i) => (
            <div
              key={i}
              className="flex animate-pulse gap-3 border-b border-border px-4 py-4 last:border-0"
            >
              <span className="h-9 w-9 rounded-full bg-muted" />
              <div className="flex-1 space-y-2">
                <div className="h-3.5 w-1/3 rounded bg-muted" />
                <div className="h-3 w-2/3 rounded bg-muted" />
              </div>
            </div>
          ))}
        </div>
      ) : visible.length === 0 ? (
        <div className="rounded-[18px] border border-dashed border-border px-6 py-10 text-center">
          <span className="mx-auto mb-3 grid h-10 w-10 place-items-center rounded-full bg-muted text-muted-foreground">
            <Inbox className="h-5 w-5" />
          </span>
          <p className="text-[14px] font-semibold text-foreground">
            {q || filter !== "all" ? "Nothing matches" : "No emails yet"}
          </p>
          <p className="mx-auto mt-1 max-w-sm text-[13px] text-muted-foreground">
            {q || filter !== "all"
              ? "Try a different search or filter."
              : "Codes, confirmations and employer replies show up here as soon as a site sends them — linked to the application they belong to."}
          </p>
        </div>
      ) : (
        <ul className="min-w-0 divide-y divide-border overflow-hidden rounded-[18px] border border-border bg-card">
          {visible.map((e) => {
            const cat = CATEGORY[e.category];
            const Icon = cat.icon;
            const fromName = e.from_name || e.from_address;
            const active = e.id === openId;
            return (
              <li key={e.id}>
                <button
                  onClick={() => select(e)}
                  className={`flex w-full items-start gap-3 px-4 py-3.5 text-left transition-colors ${
                    active ? "bg-primary-soft/50" : "hover:bg-muted/50"
                  }`}
                >
                  <span className="relative mt-0.5 grid h-9 w-9 shrink-0 place-items-center rounded-full bg-muted text-[13px] font-bold uppercase text-ink-2">
                    {fromName.slice(0, 1)}
                    {!e.read && (
                      <span className="absolute -right-0.5 -top-0.5 h-2.5 w-2.5 rounded-full bg-primary ring-2 ring-card" />
                    )}
                  </span>
                  <span className="min-w-0 flex-1 overflow-hidden">
                    <span className="flex min-w-0 items-center gap-2">
                      <span
                        className={`truncate text-[14px] ${e.read ? "font-medium text-ink-2" : "font-semibold text-foreground"}`}
                      >
                        {fromName}
                      </span>
                      <span className="ml-auto shrink-0 text-[11px] text-faint">
                        {timeAgo(ts(e.received_at))}
                      </span>
                    </span>
                    <span
                      className={`block truncate text-[13px] ${e.read ? "text-ink-2" : "font-medium text-foreground"}`}
                    >
                      {e.subject}
                    </span>
                    <span className="block truncate text-[12px] text-muted-foreground">
                      {e.snippet}
                    </span>
                    <span className="mt-1.5 flex flex-wrap items-center gap-1.5">
                      <span
                        className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-semibold ${cat.className}`}
                      >
                        <Icon className="h-3 w-3" /> {cat.label}
                      </span>
                      {e.extracted_code && (
                        <span className="rounded-full bg-muted px-2 py-0.5 font-mono text-[11px] font-semibold tracking-widest text-foreground">
                          {e.extracted_code}
                        </span>
                      )}
                      {e.intent && INTENT[e.intent] && (
                        <span
                          className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${INTENT[e.intent].className}`}
                        >
                          {INTENT[e.intent].label}
                        </span>
                      )}
                    </span>
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );

  return (
    <div className="flex min-h-0 min-w-0 max-w-full flex-1 flex-col overflow-x-hidden">
      {/* Phone: the reader replaces the list. */}
      <div className={`${open ? "hidden md:flex" : "flex"} min-h-0 min-w-0 flex-1 flex-col`}>
        <div className="scroll-thin flex-1 overflow-x-hidden overflow-y-auto px-3 pb-8 pt-2 sm:px-4">
          <div className="mx-auto w-full min-w-0 max-w-[72rem]">
            <div className="mb-4 flex flex-wrap items-end gap-x-4 gap-y-2">
              <div className="min-w-0 flex-1">
                <h1 className="text-[22px] font-bold tracking-tight text-foreground">Inbox</h1>
                <p className="text-[13px] text-muted-foreground">
                  Mail from sites and employers{unread ? ` · ${unread} unread` : ""}. Codes are
                  filled in for you.
                </p>
              </div>
              {address && (
                <button
                  onClick={() =>
                    navigator.clipboard?.writeText(address).then(() => {
                      setCopiedAddress(true);
                      setTimeout(() => setCopiedAddress(false), 1500);
                    })
                  }
                  className="inline-flex min-w-0 max-w-full items-center gap-2 rounded-full border border-border bg-card px-3 py-1.5 text-[12px] text-ink-2 hover:border-faint"
                  aria-label={`Copy your inbox address ${address}`}
                >
                  <span className="text-faint">Your address</span>
                  <span className="truncate font-medium text-foreground">{address}</span>
                  {copiedAddress ? (
                    <Check className="h-3.5 w-3.5 shrink-0 text-success" />
                  ) : (
                    <Copy className="h-3.5 w-3.5 shrink-0 text-faint" />
                  )}
                </button>
              )}
            </div>
            <div className="mb-4">
              <GmailConnect />
            </div>
            <div className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-4 md:grid-cols-[minmax(300px,380px)_minmax(0,1fr)]">
              {list}
              <div className="hidden min-w-0 md:block">
                {open ? (
                  <Reader email={open} onOpenApplication={onOpenApplication} />
                ) : (
                  <div className="grid h-72 place-items-center rounded-[18px] border border-dashed border-border text-[13px] text-muted-foreground">
                    <span className="flex flex-col items-center gap-2">
                      <MailOpen className="h-6 w-6 text-faint" /> Pick a message to read it
                    </span>
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>
      </div>
      {open && (
        <div className="scroll-thin min-w-0 flex-1 overflow-x-hidden overflow-y-auto px-3 pb-8 pt-2 md:hidden">
          <button
            onClick={() => setOpenId(null)}
            className="mb-3 inline-flex items-center gap-1.5 rounded-full px-2 py-1.5 text-[13px] font-medium text-ink-2 hover:text-foreground"
          >
            <ArrowLeft className="h-4 w-4" /> Inbox
          </button>
          <Reader email={open} onOpenApplication={onOpenApplication} />
        </div>
      )}
    </div>
  );
}

/** The whole message: who, when, which application, the code to copy, the link to open, the text. */
function Reader({
  email,
  onOpenApplication,
}: {
  email: InboxEmail;
  onOpenApplication: (id: string) => void;
}) {
  const [copied, setCopied] = useState(false);
  const full = useQuery({
    queryKey: ["email", email.id],
    queryFn: () => jp.email(email.id),
    staleTime: 60_000,
  });
  const d = full.data;
  const cat = CATEGORY[email.category];
  const body = (d?.body_text ?? "").trim() || email.snippet;
  const link = d?.extracted_link;
  const when = new Date(ts(email.received_at));

  return (
    <article
      key={email.id}
      className="min-w-0 animate-in fade-in-0 overflow-hidden rounded-[18px] border border-border bg-card p-4 duration-200 sm:p-6"
    >
      <div className="flex flex-wrap items-center gap-1.5">
        <span
          className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-semibold ${cat.className}`}
        >
          <cat.icon className="h-3 w-3" /> {cat.label}
        </span>
        {email.intent && INTENT[email.intent] && (
          <span
            className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${INTENT[email.intent].className}`}
          >
            {INTENT[email.intent].label}
          </span>
        )}
      </div>
      <h2 className="mt-2 text-[19px] font-bold leading-snug tracking-tight text-foreground">
        {email.subject || "(no subject)"}
      </h2>
      <dl className="mt-3 space-y-0.5 text-[13px]">
        <div className="flex gap-2">
          <dt className="w-10 shrink-0 text-faint">From</dt>
          <dd className="min-w-0 break-all text-foreground sm:break-words">
            {email.from_name ? `${email.from_name} ` : ""}
            <span className="text-muted-foreground">&lt;{email.from_address}&gt;</span>
          </dd>
        </div>
        {d?.to_address && (
          <div className="flex gap-2">
            <dt className="w-10 shrink-0 text-faint">To</dt>
            <dd className="min-w-0 break-words text-muted-foreground">{d.to_address}</dd>
          </div>
        )}
        <div className="flex gap-2">
          <dt className="w-10 shrink-0 text-faint">Date</dt>
          <dd className="text-muted-foreground">
            {when.toLocaleString(undefined, {
              weekday: "short",
              day: "numeric",
              month: "short",
              year: "numeric",
              hour: "2-digit",
              minute: "2-digit",
            })}
          </dd>
        </div>
      </dl>

      {(email.extracted_code || link || email.application_id) && (
        <div className="mt-4 flex flex-wrap items-center gap-2 rounded-2xl bg-muted/60 p-3">
          {email.extracted_code && (
            <button
              onClick={() =>
                navigator.clipboard?.writeText(email.extracted_code!).then(() => {
                  setCopied(true);
                  setTimeout(() => setCopied(false), 1500);
                })
              }
              className="inline-flex items-center gap-2 rounded-xl border border-border bg-card px-3.5 py-2 font-mono text-[18px] font-semibold tracking-[0.25em] text-foreground hover:border-faint"
              aria-label={`Copy code ${email.extracted_code}`}
            >
              {email.extracted_code}
              {copied ? (
                <Check className="h-4 w-4 text-success" />
              ) : (
                <Copy className="h-4 w-4 text-faint" />
              )}
            </button>
          )}
          {link && (
            <a
              href={link}
              target="_blank"
              rel="noreferrer noopener"
              className="inline-flex max-w-full items-center gap-1.5 rounded-full border border-border bg-card px-3.5 py-2 text-[13px] font-semibold text-ink-2 hover:border-faint hover:text-foreground"
            >
              <Link2 className="h-3.5 w-3.5" /> Open verification link{" "}
              <ExternalLink className="h-3 w-3 text-faint" />
            </a>
          )}
          {email.application_id && (
            <button
              onClick={() => onOpenApplication(email.application_id!)}
              className="inline-flex max-w-full items-center gap-1.5 truncate rounded-full bg-primary px-3.5 py-2 text-[13px] font-semibold text-primary-foreground hover:opacity-90"
            >
              {email.application_title ? `Open “${email.application_title}”` : "Open application"}
            </button>
          )}
        </div>
      )}

      <div className="mt-5 border-t border-border pt-4">
        {full.isLoading ? (
          <span className="inline-flex items-center gap-2 text-[13px] text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" /> Loading the message…
          </span>
        ) : (
          <EmailBody text={body} />
        )}
      </div>
    </article>
  );
}

const URL_RE = /(https?:\/\/[^\s<>"')]+)/g;

/** A link as a person would read it: the host, and a hint of the path. */
function prettyUrl(u: string): string {
  try {
    const x = new URL(u);
    const path = x.pathname.length > 1 ? x.pathname : "";
    const shown = `${x.host}${path}`;
    return shown.length > 42 ? `${shown.slice(0, 40)}…` : shown;
  } catch {
    return u.length > 42 ? `${u.slice(0, 40)}…` : u;
  }
}

/** Plain-text mail, tidied: paragraphs instead of ragged line breaks, links you can tap, no walls of URL. */
function EmailBody({ text }: { text: string }) {
  const paragraphs = text
    .replace(/\r/g, "")
    .replace(/[ \t]+/g, " ")
    .replace(/ *\n */g, "\n")
    .split(/\n{2,}/)
    // Hard-wrapped lines inside a paragraph rejoin; a URL on its own line stays its own line.
    .map((p) =>
      p
        .split("\n")
        .map((l) => l.trim())
        .filter(Boolean)
        .reduce<string[]>((acc, l) => {
          const prev = acc[acc.length - 1];
          if (prev && !/^https?:\/\//.test(l) && !/^https?:\/\/\S+$/.test(prev) && !/[.:!?]$/.test(prev))
            acc[acc.length - 1] = `${prev} ${l}`;
          else acc.push(l);
          return acc;
        }, []),
    )
    .filter((lines) => lines.length);
  return (
    <div className="space-y-3 text-[14px] leading-relaxed text-ink-2">
      {paragraphs.map((lines, i) => (
        <p key={i} className="break-words">
          {lines.map((line, j) => (
            <span key={j} className="block">
              {line.split(URL_RE).map((part, k) =>
                /^https?:\/\//.test(part) ? (
                  <a
                    key={k}
                    href={part}
                    target="_blank"
                    rel="noreferrer noopener"
                    title={part}
                    className="break-all font-medium text-primary underline underline-offset-2"
                  >
                    {prettyUrl(part)}
                  </a>
                ) : (
                  <span key={k}>{part}</span>
                ),
              )}
            </span>
          ))}
        </p>
      ))}
    </div>
  );
}

function timeAgo(ts: number): string {
  const m = Math.round((Date.now() - ts) / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h`;
  const d = Math.round(h / 24);
  return d < 7
    ? `${d}d`
    : new Date(ts).toLocaleDateString(undefined, { day: "numeric", month: "short" });
}
