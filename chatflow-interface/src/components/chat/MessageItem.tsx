import { useState } from "react";
import ReactMarkdown from "react-markdown";
import {
  ChevronDown,
  Check,
  Loader2,
  Circle,
  Download,
  FileText,
  Paperclip,
  Info,
  AlertTriangle,
  CheckCircle2,
  XCircle,
  Copy,
  Sparkles,
} from "lucide-react";
import type {
  ChatMessage,
  TimelineMessage,
  FileMessage,
  DownloadMessage,
  TextMessage,
  InputCardMessage,
  StatusMessage,
  ReviewMessage,
  ReceiptMessage,
  JobCardsMessage,
  AskMessage,
  ActionsMessage,
  AppsStatusMessage,
} from "@/lib/chat-types";
import { InputCard } from "./InputCard";
import { ReviewCard } from "./ReviewCard";
import { ReceiptCard } from "./ReceiptCard";
import { ActionsView, AppsStatusView, AskView, JobCardsView } from "./AiCards";
import { config } from "@/lib/config";
import { nativeHeaders } from "@/lib/native";

export function MessageItem({ msg }: { msg: ChatMessage }) {
  const isUser = msg.role === "user";
  if (isUser) {
    return (
      <div
        id={`msg-${msg.id}`}
        className="animate-in scroll-mt-4 px-3 py-2 fade-in-0 slide-in-from-bottom-1 duration-300 sm:px-4"
      >
        {/* Same centered column as the bot's reply below, so the user's
            bubble hugs the column's right edge instead of the viewport's. */}
        <div className="mx-auto flex max-w-(--chat-w) justify-end">
          <div className="max-w-[85%] sm:max-w-[75%]">
            {msg.type === "text" && (
              <div className="rounded-[22px] rounded-br-md bg-bubble-user px-4 py-2.5 text-[15px] leading-relaxed text-bubble-user-foreground">
                {(msg as TextMessage).content}
              </div>
            )}
            {msg.type === "file-upload" && <UserFileBubble msg={msg as FileMessage} />}
          </div>
        </div>
      </div>
    );
  }

  // Bot side – no background, full width content
  return (
    <div
      id={`msg-${msg.id}`}
      className="animate-in scroll-mt-4 px-3 py-2.5 fade-in-0 slide-in-from-bottom-1 duration-300 sm:px-4"
    >
      <div className="mx-auto flex max-w-(--chat-w)">
        <div className="min-w-0 flex-1">
          {msg.type === "text" && <BotText msg={msg as TextMessage} />}
          {msg.type === "timeline" && <Timeline msg={msg as TimelineMessage} />}
          {msg.type === "input-card" && (
            <div aria-busy={!!(msg as InputCardMessage).submitting} className={(msg as InputCardMessage).submitting ? "pointer-events-none opacity-70" : ""}>
              <InputCard msg={msg as InputCardMessage} />
              {(msg as InputCardMessage).submitting && (
                <p role="status" aria-live="polite" className="mt-2 text-center text-[12px] text-muted-foreground">
                  Sending your answer…
                </p>
              )}
            </div>
          )}
          {msg.type === "download" && <DownloadCard msg={msg as DownloadMessage} />}
          {msg.type === "status" && <StatusBubble msg={msg as StatusMessage} />}
          {msg.type === "review" && <ReviewCard msg={msg as ReviewMessage} />}
          {msg.type === "receipt" && <ReceiptCard msg={msg as ReceiptMessage} />}
          {msg.type === "job-cards" && <JobCardsView msg={msg as JobCardsMessage} />}
          {msg.type === "ask" && <AskView msg={msg as AskMessage} />}
          {msg.type === "actions" && <ActionsView msg={msg as ActionsMessage} />}
          {msg.type === "apps-status" && <AppsStatusView msg={msg as AppsStatusMessage} />}
        </div>
      </div>
    </div>
  );
}

function BotText({ msg }: { msg: TextMessage }) {
  const [copied, setCopied] = useState(false);

  const copyReply = async () => {
    try {
      await navigator.clipboard.writeText(msg.content);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      setCopied(false);
    }
  };

  return (
    <div className="group/bot-reply animate-in fade-in-0 duration-200">
      <div className="md break-words text-[15px] leading-[1.72] text-foreground">
        <ReactMarkdown
          components={{
            a: ({ href, children }) => (
              <a href={href} target="_blank" rel="noreferrer noopener">
                {children}
              </a>
            ),
          }}
        >
          {msg.content}
        </ReactMarkdown>
      </div>
      {msg.content.trim() && (
        <div className="mt-2 flex min-h-7 items-center opacity-100 transition-opacity sm:opacity-0 sm:group-hover/bot-reply:opacity-100 sm:group-focus-within/bot-reply:opacity-100">
          <button
            type="button"
            onClick={copyReply}
            aria-label={copied ? "Copied response" : "Copy response"}
            title={copied ? "Copied" : "Copy response"}
            className="inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
            <span>{copied ? "Copied" : "Copy"}</span>
          </button>
        </div>
      )}
    </div>
  );
}

function UserFileBubble({ msg }: { msg: FileMessage }) {
  return (
    <div className="rounded-2xl rounded-br-md bg-bubble-user px-3 py-2.5 text-sm text-bubble-user-foreground space-y-2">
      {msg.files.map((f) => (
        <div key={f.id} className="flex items-center gap-2 rounded-lg bg-background/10 px-2 py-1.5">
          <Paperclip className="h-3.5 w-3.5 opacity-80" />
          <div className="min-w-0 flex-1">
            <div className="truncate text-xs font-medium">{f.name}</div>
            <div className="text-[10px] opacity-70">{(f.size / 1024).toFixed(1)} KB</div>
          </div>
        </div>
      ))}
      {msg.note && <div>{msg.note}</div>}
    </div>
  );
}

function Timeline({ msg }: { msg: TimelineMessage }) {
  const [open, setOpen] = useState(!msg.done);
  const active = msg.steps.find((s) => s.status === "active");
  const doneCount = msg.steps.filter((s) => s.status === "done").length;
  const pct = msg.steps.length ? Math.round((doneCount / msg.steps.length) * 100) : 0;
  return (
    <div className="overflow-hidden rounded-[18px] border border-border bg-card shadow-[0_1px_2px_rgba(13,24,40,0.04)]">
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-3 px-4 py-3 text-left"
      >
        <span
          className={`grid h-8 w-8 shrink-0 place-items-center rounded-full ${
            msg.done
              ? "bg-primary text-primary-foreground"
              : "bg-primary-soft text-primary-soft-foreground"
          }`}
        >
          {msg.done ? (
            <Check className="h-4 w-4" strokeWidth={2.5} />
          ) : (
            <Loader2 className="h-4 w-4 animate-spin" />
          )}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[14px] font-semibold text-foreground">
            {msg.title}
          </span>
          <span className="block truncate text-[12px] text-muted-foreground">
            {msg.done
              ? `Done · ${msg.steps.length} steps`
              : active
                ? active.label
                : `${doneCount} of ${msg.steps.length} steps`}
          </span>
        </span>
        <ChevronDown
          className={`h-4 w-4 shrink-0 text-faint transition-transform ${open ? "" : "-rotate-90"}`}
        />
      </button>
      {!msg.done && (
        <div className="mx-4 mb-3 h-1 overflow-hidden rounded-full bg-muted">
          <div
            className="h-full rounded-full bg-primary transition-[width] duration-500"
            style={{ width: `${Math.max(pct, 6)}%` }}
          />
        </div>
      )}
      {open && (
        <ol className="space-y-2.5 border-t border-border px-4 py-3 text-[13px]">
          {msg.steps.map((s) => (
            <li key={s.id} className="flex items-center gap-2.5">
              {s.status === "done" ? (
                <Check className="h-3.5 w-3.5 text-success" strokeWidth={2.5} />
              ) : s.status === "active" ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin text-primary" />
              ) : s.status === "error" ? (
                <XCircle className="h-3.5 w-3.5 text-destructive" />
              ) : (
                <Circle className="h-3 w-3 text-faint" />
              )}
              <span
                className={
                  s.status === "active"
                    ? "font-medium text-foreground"
                    : s.status === "error"
                      ? "text-destructive"
                      : s.status === "done"
                        ? "text-ink-2"
                        : "text-faint"
                }
              >
                {s.label}
              </span>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

function DownloadCard({ msg }: { msg: DownloadMessage }) {
  const downloadFile = () => {
    // Use backend download URL if fileId is available
    if (msg.fileId || msg.downloadUrl) {
      const url = msg.downloadUrl || `${config.apiBaseUrl}/files/${msg.fileId}/download`;

      // Open in a new tab / trigger download with auth header
      // For simple downloads, we use a hidden anchor
      const a = document.createElement("a");
      a.href = url;
      a.download = msg.fileName;
      // Note: x-api-key can't be sent via <a> tag, so for authenticated downloads
      // we'd need to use fetch + blob. For now, try direct:
      nativeHeaders().then((auth) =>
        fetch(url, {
          headers: { "x-api-key": config.apiKey, ...auth },
          credentials: "include", // sends the jp_session cookie so the backend can authorize this file
        })
          .then((res) => res.blob())
          .then((blob) => {
            const blobUrl = URL.createObjectURL(blob);
            const link = document.createElement("a");
            link.href = blobUrl;
            link.download = msg.fileName;
            link.click();
            URL.revokeObjectURL(blobUrl);
          })
          .catch(() => {
            // Fallback: direct link
            a.click();
          }),
      );
      return;
    }

    // Fallback: mock file
    const blob = new Blob([`Content of ${msg.fileName}\nGenerated by Agent.`], {
      type: msg.mime || "text/plain",
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = msg.fileName;
    a.click();
    URL.revokeObjectURL(url);
  };
  return (
    <div className="flex items-center gap-3 rounded-[18px] border border-border bg-card p-3 shadow-[0_1px_2px_rgba(13,24,40,0.04)]">
      <div className="grid h-11 w-11 place-items-center rounded-xl bg-primary-soft text-primary-soft-foreground">
        <FileText className="h-5 w-5" />
      </div>
      <div className="min-w-0 flex-1">
        <div className="truncate text-[14px] font-semibold text-foreground">{msg.title}</div>
        <div className="truncate text-xs text-muted-foreground">
          {msg.fileName}
          {msg.sizeLabel ? ` · ${msg.sizeLabel}` : ""}
          {msg.description ? ` · ${msg.description}` : ""}
        </div>
      </div>
      <button
        onClick={downloadFile}
        className="flex shrink-0 items-center gap-1.5 rounded-full bg-primary px-3.5 py-2 text-[13px] font-semibold text-primary-foreground transition-all duration-150 hover:opacity-90 active:scale-95"
      >
        <Download className="h-3.5 w-3.5" /> Download
      </button>
    </div>
  );
}

function StatusBubble({ msg }: { msg: StatusMessage }) {
  const variants = {
    info: { icon: Info, color: "text-muted-foreground", bg: "bg-card border-border" },
    success: {
      icon: CheckCircle2,
      color: "text-success",
      bg: "bg-primary-soft border-primary-border",
    },
    warning: {
      icon: AlertTriangle,
      color: "text-warning-soft-foreground",
      bg: "bg-warning-soft border-transparent",
    },
    error: {
      icon: XCircle,
      color: "text-destructive",
      bg: "bg-destructive/5 border-destructive/20",
    },
  };
  const v = variants[msg.variant] || variants.info;
  const Icon = v.icon;

  return (
    <div className={`flex items-center gap-2 rounded-2xl border px-3.5 py-2.5 text-[13px] ${v.bg}`}>
      <Icon className={`h-4 w-4 shrink-0 ${v.color}`} />
      <span className="text-ink-2">{msg.content}</span>
    </div>
  );
}

export function TypingIndicator({ label }: { label: string }) {
  return (
    <div className="px-3 py-3 sm:px-4" role="status" aria-live="polite">
      <div className="mx-auto flex max-w-(--chat-w) items-center gap-2.5 text-[13px] text-muted-foreground">
        <span className="grid h-7 w-7 shrink-0 place-items-center rounded-full bg-primary-soft text-primary-soft-foreground">
          <Sparkles className="h-3.5 w-3.5 animate-pulse" />
        </span>
        <span>{label}</span>
        <span className="flex items-center gap-1" aria-hidden="true">
          <span className="typing-dot" />
          <span className="typing-dot" />
          <span className="typing-dot" />
        </span>
      </div>
    </div>
  );
}
