import React, { useState, useEffect } from "react";
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
} from "lucide-react";
import type {
  ChatMessage,
  TimelineMessage,
  FileMessage,
  DownloadMessage,
  TextMessage,
  InputCardMessage,
  StatusMessage,
} from "@/lib/chat-types";
import { InputCard } from "./InputCard";
import { config } from "@/lib/config";

// ⚡ Bolt Optimization: Wrapped in React.memo to prevent unnecessary re-renders
// of past messages when new ones arrive or user types, as state is immutable.
export const MessageItem = React.memo(function MessageItem({ msg }: { msg: ChatMessage }) {
  const isUser = msg.role === "user";
  if (isUser) {
    return (
      <div className="flex justify-end px-4 py-2">
        <div className="max-w-[78%]">
          {msg.type === "text" && (
            <div className="rounded-2xl rounded-br-md bg-bubble-user px-4 py-2.5 text-sm text-bubble-user-foreground">
              {(msg as TextMessage).content}
            </div>
          )}
          {msg.type === "file-upload" && <UserFileBubble msg={msg as FileMessage} />}
        </div>
      </div>
    );
  }

  // Bot side – no background, full width content
  return (
    <div className="px-4 py-3">
      <div className="mx-auto flex max-w-3xl gap-3">
        <div className="mt-0.5 grid h-7 w-7 shrink-0 place-items-center rounded-lg bg-primary/15 text-primary text-[11px] font-bold">
          A
        </div>
        <div className="min-w-0 flex-1">
          {msg.type === "text" && <BotText msg={msg as TextMessage} />}
          {msg.type === "timeline" && <Timeline msg={msg as TimelineMessage} />}
          {msg.type === "input-card" && <InputCard msg={msg as InputCardMessage} />}
          {msg.type === "download" && <DownloadCard msg={msg as DownloadMessage} />}
          {msg.type === "status" && <StatusBubble msg={msg as StatusMessage} />}
        </div>
      </div>
    </div>
  );
});

function BotText({ msg }: { msg: TextMessage }) {
  const [displayed, setDisplayed] = useState("");
  const [isTyping, setIsTyping] = useState(false);

  useEffect(() => {
    // Only animate if the message was created in the last 2 seconds (new incoming message)
    const isNew = Date.now() - msg.createdAt < 2000;

    if (!isNew) {
      setDisplayed(msg.content);
      return;
    }

    setIsTyping(true);
    let i = 0;
    const interval = setInterval(() => {
      // Advance by a few characters to make it look like fast typing
      i += Math.floor(Math.random() * 3) + 2;
      if (i >= msg.content.length) {
        setDisplayed(msg.content);
        setIsTyping(false);
        clearInterval(interval);
      } else {
        setDisplayed(msg.content.substring(0, i));
      }
    }, 15);

    return () => clearInterval(interval);
  }, [msg.content, msg.createdAt]);

  return (
    <div className="md text-[15px] leading-relaxed text-foreground">
      <ReactMarkdown>{displayed}</ReactMarkdown>
      {isTyping && (
        <span className="inline-block w-2 h-[15px] ml-1 bg-primary/70 align-middle animate-pulse" />
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
  const [open, setOpen] = useState(true);
  const active = msg.steps.find((s) => s.status === "active");
  return (
    <div className="rounded-2xl border border-border bg-card/60">
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2 px-3 py-2.5 text-sm font-medium"
      >
        {msg.done ? (
          <Check className="h-4 w-4 text-primary" />
        ) : (
          <Loader2 className="h-4 w-4 animate-spin text-primary" />
        )}
        <span>{msg.title}</span>
        {active && !msg.done && (
          <span className="text-xs font-normal text-muted-foreground">· {active.label}</span>
        )}
        <ChevronDown
          className={`ml-auto h-4 w-4 text-muted-foreground transition ${open ? "" : "-rotate-90"}`}
        />
      </button>
      {open && (
        <ol className="space-y-2 border-t border-border px-4 py-3 text-sm">
          {msg.steps.map((s) => (
            <li key={s.id} className="flex items-center gap-2.5">
              {s.status === "done" ? (
                <Check className="h-3.5 w-3.5 text-primary" />
              ) : s.status === "active" ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin text-primary" />
              ) : s.status === "error" ? (
                <XCircle className="h-3.5 w-3.5 text-destructive" />
              ) : (
                <Circle className="h-3 w-3 text-muted-foreground/60" />
              )}
              <span
                className={
                  s.status === "done"
                    ? "text-muted-foreground line-through"
                    : s.status === "active"
                      ? "text-foreground"
                      : s.status === "error"
                        ? "text-destructive"
                        : "text-muted-foreground"
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
      const url =
        msg.downloadUrl ||
        `${config.apiBaseUrl}/files/${msg.fileId}/download?userId=${config.userId}`;

      // Open in a new tab / trigger download with auth header
      // For simple downloads, we use a hidden anchor
      const a = document.createElement("a");
      a.href = url;
      a.download = msg.fileName;
      // Note: x-api-key can't be sent via <a> tag, so for authenticated downloads
      // we'd need to use fetch + blob. For now, try direct:
      fetch(url, {
        headers: { "x-api-key": config.apiKey },
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
        });
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
    <div className="flex items-center gap-3 rounded-2xl border border-border bg-card p-3 shadow-sm">
      <div className="grid h-11 w-11 place-items-center rounded-xl bg-primary/15 text-primary">
        <FileText className="h-5 w-5" />
      </div>
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-medium">{msg.title}</div>
        <div className="truncate text-xs text-muted-foreground">
          {msg.fileName}
          {msg.sizeLabel ? ` · ${msg.sizeLabel}` : ""}
          {msg.description ? ` · ${msg.description}` : ""}
        </div>
      </div>
      <button
        onClick={downloadFile}
        className="flex shrink-0 items-center gap-1.5 rounded-lg bg-primary px-3 py-2 text-xs font-medium text-primary-foreground hover:opacity-90"
      >
        <Download className="h-3.5 w-3.5" /> Download
      </button>
    </div>
  );
}

function StatusBubble({ msg }: { msg: StatusMessage }) {
  const variants = {
    info: { icon: Info, color: "text-blue-400", bg: "bg-blue-500/10 border-blue-500/20" },
    success: { icon: CheckCircle2, color: "text-primary", bg: "bg-primary/10 border-primary/20" },
    warning: { icon: AlertTriangle, color: "text-warning", bg: "bg-warning/10 border-warning/20" },
    error: {
      icon: XCircle,
      color: "text-destructive",
      bg: "bg-destructive/10 border-destructive/20",
    },
  };
  const v = variants[msg.variant] || variants.info;
  const Icon = v.icon;

  return (
    <div className={`flex items-center gap-2 rounded-xl border px-3 py-2 text-sm ${v.bg}`}>
      <Icon className={`h-4 w-4 shrink-0 ${v.color}`} />
      <span className="text-muted-foreground">{msg.content}</span>
    </div>
  );
}

export function TypingIndicator() {
  return (
    <div className="px-4 py-3">
      <div className="mx-auto flex max-w-3xl gap-3">
        <div className="mt-0.5 grid h-7 w-7 shrink-0 place-items-center rounded-lg bg-primary/15 text-primary text-[11px] font-bold animate-pulse">
          A
        </div>
        <div className="flex items-center gap-2 pt-1">
          <div className="h-4 w-4 rounded-full border-2 border-primary/30 border-t-primary animate-spin" />
          <span className="text-sm font-medium text-muted-foreground animate-pulse">
            Thinking...
          </span>
        </div>
      </div>
    </div>
  );
}
